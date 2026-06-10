import type { Observable, WebSocketContext } from '@datadog/browser-core'
import { generateUUID, initWebSocketObservable, sanitize } from '@datadog/browser-core'
import type { ClocksState, Duration, TimeStamp } from '@datadog/js-core/time'
import { clocksNow, elapsed } from '@datadog/js-core/time'
import { VitalType } from '../rawRumEvent.types'
import type { RumConfiguration } from './configuration'
import type { ViewHistory } from './contexts/viewHistory'
import type { LifeCycle } from './lifeCycle'
import { LifeCycleEventType } from './lifeCycle'
import type { DurationVital } from './vital/vitalCollection'

export const WEBSOCKET_CONNECTING_VITAL_NAME = 'websocket-connecting'

export type WebSocketTrackingEndReason = 'close_event' | 'session_end'

export interface WebSocketCompleteEvent {
  connectionId: string
  url: string
  protocol?: string
  startClocks: ClocksState
  endClocks: ClocksState
  startViewId?: string
  endViewId?: string
  messagesIn: { count: number; size: number }
  messagesOut: { count: number; size: number }
  firstMessageInOffset?: Duration
  firstMessageOutOffset?: Duration
  lastMessageAt?: TimeStamp
  longestSilence: Duration
  bufferedAmountMax: number
  idleDurationBeforeClose?: Duration
  closeCode?: number
  closeReason?: string
  wasClean?: boolean
  handshakeSucceeded: boolean
  trackingEndReason: WebSocketTrackingEndReason
  setupDuration?: Duration
}

interface WebSocketConnection {
  connectionId: string
  url: string
  protocol?: string
  startClocks: ClocksState
  openClocks?: ClocksState
  startViewId?: string
  messagesIn: { count: number; size: number }
  messagesOut: { count: number; size: number }
  firstMessageInOffset?: Duration
  firstMessageOutOffset?: Duration
  lastMessageAt?: TimeStamp
  longestSilence: Duration
  bufferedAmountMax: number
  setupDuration?: Duration
}

export interface WebSocketConnectionTracker {
  flushOpenConnections: (reason: WebSocketTrackingEndReason) => void
  stop: () => void
}

export function startWebSocketCollection(
  lifeCycle: LifeCycle,
  configuration: RumConfiguration,
  viewHistory: ViewHistory,
  addDurationVital: (vital: DurationVital) => void
) {
  const tracker = trackWebSocket(
    lifeCycle,
    initWebSocketObservable({ allowUntrustedEvents: configuration.allowUntrustedEvents }),
    viewHistory,
    addDurationVital
  )

  const sessionExpiredSubscription = lifeCycle.subscribe(LifeCycleEventType.SESSION_EXPIRED, () => {
    tracker.flushOpenConnections('session_end')
  })

  return {
    stop: () => {
      sessionExpiredSubscription.unsubscribe()
      tracker.flushOpenConnections('session_end')
      tracker.stop()
    },
  }
}

export function trackWebSocket(
  lifeCycle: LifeCycle,
  webSocketContextObservable: Observable<WebSocketContext>,
  viewHistory: ViewHistory,
  addDurationVital: (vital: DurationVital) => void
): WebSocketConnectionTracker {
  const webSocketRegistry = new Map<WebSocket, WebSocketConnection>()

  const subscription = webSocketContextObservable.subscribe((context) => {
    switch (context.state) {
      case 'connecting': {
        const connectionId = generateUUID()
        const startViewId = viewHistory.findView(context.startClocks.relative)?.id
        const webSocket: WebSocketConnection = {
          connectionId,
          url: context.url,
          startClocks: context.startClocks,
          startViewId,
          messagesIn: { count: 0, size: 0 },
          messagesOut: { count: 0, size: 0 },
          longestSilence: 0 as Duration,
          bufferedAmountMax: 0,
        }
        webSocketRegistry.set(context.instance, webSocket)

        addDurationVital({
          id: connectionId,
          name: WEBSOCKET_CONNECTING_VITAL_NAME,
          type: VitalType.DURATION,
          startClocks: context.startClocks,
          duration: 0 as Duration,
          context: sanitize({
            url: context.url,
            ...(context.protocols !== undefined ? { protocols: context.protocols } : {}),
            ...(startViewId !== undefined ? { startViewId } : {}),
          }),
        })
        return
      }
      case 'open': {
        const webSocket = webSocketRegistry.get(context.instance)
        if (!webSocket) {
          return
        }
        webSocket.openClocks = context.openClocks
        webSocket.protocol = context.protocol
        webSocket.setupDuration = elapsed(webSocket.startClocks.timeStamp, context.openClocks.timeStamp)
        return
      }
      case 'message-in': {
        const webSocket = webSocketRegistry.get(context.instance)
        if (!webSocket) {
          return
        }
        webSocket.messagesIn.count += 1
        webSocket.messagesIn.size += context.size
        recordMessageTiming(webSocket, context.at, 'in')
        return
      }
      case 'message-out': {
        const webSocket = webSocketRegistry.get(context.instance)
        if (!webSocket) {
          return
        }
        webSocket.messagesOut.count += 1
        webSocket.messagesOut.size += context.size
        if (context.bufferedAmountPreSend > webSocket.bufferedAmountMax) {
          webSocket.bufferedAmountMax = context.bufferedAmountPreSend
        }
        recordMessageTiming(webSocket, context.at, 'out')
        return
      }
      case 'close': {
        const webSocket = webSocketRegistry.get(context.instance)
        if (!webSocket) {
          return
        }
        webSocketRegistry.delete(context.instance)
        lifeCycle.notify(LifeCycleEventType.WEBSOCKET_COMPLETED, buildCompletedEvent(webSocket, context, 'close_event'))
        return
      }
    }
  })

  function buildCompletedEvent(
    webSocket: WebSocketConnection,
    endInfo: { at: ClocksState; code?: number; reason?: string; wasClean?: boolean },
    trackingEndReason: WebSocketTrackingEndReason
  ): WebSocketCompleteEvent {
    const endClocks = endInfo.at
    const endViewId = viewHistory.findView(endClocks.relative)?.id
    const idleDurationBeforeClose =
      webSocket.lastMessageAt !== undefined ? elapsed(webSocket.lastMessageAt, endClocks.timeStamp) : undefined

    return {
      connectionId: webSocket.connectionId,
      url: webSocket.url,
      protocol: webSocket.protocol,
      startClocks: webSocket.startClocks,
      endClocks,
      startViewId: webSocket.startViewId,
      endViewId,
      messagesIn: webSocket.messagesIn,
      messagesOut: webSocket.messagesOut,
      firstMessageInOffset: webSocket.firstMessageInOffset,
      firstMessageOutOffset: webSocket.firstMessageOutOffset,
      lastMessageAt: webSocket.lastMessageAt,
      longestSilence: webSocket.longestSilence,
      bufferedAmountMax: webSocket.bufferedAmountMax,
      idleDurationBeforeClose,
      closeCode: endInfo.code,
      closeReason: endInfo.reason,
      wasClean: endInfo.wasClean,
      handshakeSucceeded: webSocket.openClocks !== undefined,
      trackingEndReason,
      setupDuration: webSocket.setupDuration ?? elapsed(webSocket.startClocks.timeStamp, endClocks.timeStamp),
    }
  }

  return {
    flushOpenConnections: (reason) => {
      const at = clocksNow()
      webSocketRegistry.forEach((webSocket) => {
        lifeCycle.notify(LifeCycleEventType.WEBSOCKET_COMPLETED, buildCompletedEvent(webSocket, { at }, reason))
      })
      webSocketRegistry.clear()
    },
    stop: () => {
      subscription.unsubscribe()
      webSocketRegistry.clear()
    },
  }
}

function recordMessageTiming(webSocket: WebSocketConnection, at: ClocksState, direction: 'in' | 'out') {
  if (webSocket.openClocks) {
    const offset = elapsed(webSocket.openClocks.timeStamp, at.timeStamp)
    if (direction === 'in' && webSocket.firstMessageInOffset === undefined) {
      webSocket.firstMessageInOffset = offset
    } else if (direction === 'out' && webSocket.firstMessageOutOffset === undefined) {
      webSocket.firstMessageOutOffset = offset
    }
  }

  if (webSocket.lastMessageAt !== undefined) {
    const gap = elapsed(webSocket.lastMessageAt, at.timeStamp)
    if (gap > webSocket.longestSilence) {
      webSocket.longestSilence = gap
    }
  }
  webSocket.lastMessageAt = at.timeStamp
}
