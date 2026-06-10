import type { WebSocketContext } from '@datadog/browser-core'
import { initWebSocketObservable, Observable } from '@datadog/browser-core'
import { registerCleanupTask } from '@datadog/browser-core/test'
import type { ClocksState, Duration, RelativeTime } from '@datadog/js-core/time'
import { elapsed, relativeToClocks } from '@datadog/js-core/time'
import { mockRumConfiguration, mockViewHistory } from '../../test'
import { VitalType } from '../rawRumEvent.types'
import type { ViewHistoryEntry } from './contexts/viewHistory'
import { LifeCycle, LifeCycleEventType } from './lifeCycle'
import type { DurationVital } from './vital/vitalCollection'
import type { WebSocketCompleteEvent } from './webSocketCollection'
import { startWebSocketCollection, trackWebSocket, WEBSOCKET_CONNECTING_VITAL_NAME } from './webSocketCollection'

describe('webSocketCollection', () => {
  let lifeCycle: LifeCycle
  let wsObservable: Observable<WebSocketContext>
  let completed: WebSocketCompleteEvent[]
  let wsInstance: WebSocket

  beforeEach(() => {
    lifeCycle = new LifeCycle()
    wsObservable = new Observable<WebSocketContext>()
    completed = []
    wsInstance = {} as WebSocket
    lifeCycle.subscribe(LifeCycleEventType.WEBSOCKET_COMPLETED, (webSocket) => {
      completed.push(webSocket)
    })
  })

  function startTracking(
    viewHistory = mockViewHistory(),
    addDurationVital: (vital: DurationVital) => void = jasmine.createSpy()
  ) {
    return trackWebSocket(lifeCycle, wsObservable, viewHistory, addDurationVital)
  }

  function notifyConnecting(
    startRelative = 0,
    url = 'wss://example.com/socket',
    startClocks?: ClocksState,
    protocols?: string | string[]
  ) {
    wsObservable.notify({
      state: 'connecting',
      instance: wsInstance,
      url,
      ...(protocols !== undefined ? { protocols } : {}),
      startClocks: startClocks ?? relativeToClocks(startRelative as RelativeTime),
    })
  }

  function notifyOpen(openRelative = 10, protocol = '', openClocks?: ClocksState) {
    wsObservable.notify({
      state: 'open',
      instance: wsInstance,
      openClocks: openClocks ?? relativeToClocks(openRelative as RelativeTime),
      protocol,
    })
  }

  function notifyMessageIn(at: number, size: number) {
    wsObservable.notify({ state: 'message-in', instance: wsInstance, size, at: relativeToClocks(at as RelativeTime) })
  }

  function notifyMessageOut(at: number, size: number, bufferedAmountPreSend = 0) {
    wsObservable.notify({
      state: 'message-out',
      instance: wsInstance,
      size,
      bufferedAmountPreSend,
      at: relativeToClocks(at as RelativeTime),
    })
  }

  function notifyClose(at: number, code: number, reason: string, wasClean: boolean, atClocks?: ClocksState) {
    wsObservable.notify({
      state: 'close',
      instance: wsInstance,
      code,
      reason,
      wasClean,
      at: atClocks ?? relativeToClocks(at as RelativeTime),
    })
  }

  it('emits a completed event on close with tracking_end_reason="close_event"', () => {
    const url = 'wss://example.com/socket'
    const protocol = 'chat.v1'
    const messageInSize = 100
    const messageOutSize = 50
    const bufferedAmount = 8
    const closeCode = 1000
    const closeReason = 'bye'

    startTracking()
    notifyConnecting(0, url)
    notifyOpen(10, protocol)
    notifyMessageIn(20, messageInSize)
    notifyMessageOut(30, messageOutSize, bufferedAmount)
    notifyClose(40, closeCode, closeReason, true)

    expect(completed.length).toBe(1)
    const webSocket = completed[0]
    expect(webSocket.trackingEndReason).toBe('close_event')
    expect(webSocket.closeCode).toBe(closeCode)
    expect(webSocket.closeReason).toBe(closeReason)
    expect(webSocket.wasClean).toBeTrue()
    expect(webSocket.url).toBe(url)
    expect(webSocket.protocol).toBe(protocol)
    expect(webSocket.messagesIn).toEqual({ count: 1, size: messageInSize })
    expect(webSocket.messagesOut).toEqual({ count: 1, size: messageOutSize })
    expect(webSocket.bufferedAmountMax).toBe(bufferedAmount)
  })

  it('generates a unique connection_id per connection', () => {
    startTracking()
    notifyConnecting()
    notifyClose(1, 1000, 'a', true)
    const firstId = completed[0].connectionId

    wsInstance = {} as WebSocket
    notifyConnecting()
    notifyClose(1, 1000, 'b', true)

    expect(completed[1].connectionId).not.toBe(firstId)
  })

  it('records firstMessageInOffset / firstMessageOutOffset as offsets from open', () => {
    const openAt = 10
    const firstMessageInAt = 13
    const firstMessageOutAt = 17

    startTracking()
    notifyConnecting()
    notifyOpen(openAt)
    notifyMessageIn(firstMessageInAt, 1)
    notifyMessageIn(25, 1) // not first; should not update
    notifyMessageOut(firstMessageOutAt, 1)
    notifyClose(30, 1000, 'bye', true)

    const webSocket = completed[0]
    expect(webSocket.firstMessageInOffset).toBe((firstMessageInAt - openAt) as Duration)
    expect(webSocket.firstMessageOutOffset).toBe((firstMessageOutAt - openAt) as Duration)
  })

  it('tracks longestSilence across consecutive messages (in or out)', () => {
    const previousMessageAt = 25
    const longestGap = 15

    startTracking()
    notifyConnecting()
    notifyOpen(10)
    notifyMessageIn(20, 1) // first - no gap
    notifyMessageOut(previousMessageAt, 1) // gap = 5
    notifyMessageIn(previousMessageAt + longestGap, 1) // gap = longestGap (max)
    notifyMessageOut(50, 1) // gap = 10
    notifyClose(100, 1000, 'bye', true)

    expect(completed[0].longestSilence).toBe(longestGap as Duration)
  })

  it('records idleDurationBeforeClose from last message to close', () => {
    const lastMessageAt = 20
    const closeAt = 50

    startTracking()
    notifyConnecting()
    notifyOpen(10)
    notifyMessageIn(lastMessageAt, 1)
    notifyClose(closeAt, 1000, 'bye', true)

    expect(completed[0].idleDurationBeforeClose).toBe((closeAt - lastMessageAt) as Duration)
  })

  it('leaves idleDurationBeforeClose undefined when no message was received', () => {
    startTracking()
    notifyConnecting()
    notifyOpen(10)
    notifyClose(50, 1000, 'bye', true)

    expect(completed[0].idleDurationBeforeClose).toBeUndefined()
  })

  it('records setupDuration as elapsed time from connecting to open', () => {
    const startAt = 0 as RelativeTime
    const openAt = 10 as RelativeTime
    const startClocks = relativeToClocks(startAt)
    const openClocks = relativeToClocks(openAt)
    const expectedSetupDuration = elapsed(startClocks.timeStamp, openClocks.timeStamp)

    startTracking()
    notifyConnecting(startAt, 'wss://example.com/socket', startClocks)
    notifyOpen(openAt, '', openClocks)
    notifyClose(40, 1000, 'bye', true)

    expect(completed[0].setupDuration).toBe(expectedSetupDuration)
  })

  describe('handshakeSucceeded', () => {
    it('is true when the open event fired before completion', () => {
      startTracking()
      notifyConnecting()
      notifyOpen(10)
      notifyClose(40, 1000, 'bye', true)
      expect(completed[0].handshakeSucceeded).toBeTrue()

      const tracker = startTracking()
      notifyConnecting()
      notifyOpen(10)
      tracker.flushOpenConnections('session_end')
      expect(completed[1].handshakeSucceeded).toBeTrue()
    })

    it('is false when the open event never fired before completion', () => {
      startTracking()
      notifyConnecting()
      notifyClose(25, 1006, 'abnormal', false)
      expect(completed[0].handshakeSucceeded).toBeFalse()

      const tracker = startTracking()
      notifyConnecting()
      tracker.flushOpenConnections('session_end')
      expect(completed[1].handshakeSucceeded).toBeFalse()
    })
  })

  it('records setupDuration as elapsed time from connecting to close when open never fires', () => {
    const startAt = 0 as RelativeTime
    const closeAt = 25 as RelativeTime
    const closeCode = 1006
    const closeReason = 'abnormal'
    const startClocks = relativeToClocks(startAt)
    const closeClocks = relativeToClocks(closeAt)
    const expectedSetupDuration = elapsed(startClocks.timeStamp, closeClocks.timeStamp)

    startTracking()
    notifyConnecting(startAt, 'wss://example.com/socket', startClocks)
    notifyClose(closeAt, closeCode, closeReason, false, closeClocks)

    expect(completed[0].setupDuration).toBe(expectedSetupDuration)
  })

  it('records setupDuration on session_end flush when the connection never opened', () => {
    const tracker = startTracking()
    notifyConnecting()
    tracker.flushOpenConnections('session_end')

    const webSocket = completed[0]
    expect(webSocket.setupDuration).toBe(elapsed(webSocket.startClocks.timeStamp, webSocket.endClocks.timeStamp))
  })

  it('does not extend setupDuration on session_end flush after open', () => {
    const startAt = 0 as RelativeTime
    const openAt = 10 as RelativeTime
    const startClocks = relativeToClocks(startAt)
    const openClocks = relativeToClocks(openAt)
    const expectedSetupDuration = elapsed(startClocks.timeStamp, openClocks.timeStamp)

    const tracker = startTracking()
    notifyConnecting(startAt, 'wss://example.com/socket', startClocks)
    notifyOpen(openAt, '', openClocks)
    tracker.flushOpenConnections('session_end')

    expect(completed[0].setupDuration).toBe(expectedSetupDuration)
  })

  it('samples buffered_amount_max from message-out events', () => {
    const peakBufferedAmount = 100

    startTracking()
    notifyConnecting()
    notifyOpen(10)
    notifyMessageOut(20, 1, 10)
    notifyMessageOut(30, 1, peakBufferedAmount)
    notifyMessageOut(40, 1, 50)
    notifyClose(50, 1000, 'bye', true)

    expect(completed[0].bufferedAmountMax).toBe(peakBufferedAmount)
  })

  it('captures startViewId and endViewId from viewHistory', () => {
    const viewByRelative: Record<number, ViewHistoryEntry> = {
      0: { id: 'view-start', startClocks: relativeToClocks(0 as RelativeTime) },
      100: { id: 'view-end', startClocks: relativeToClocks(100 as RelativeTime) },
    }
    const viewHistory = mockViewHistory()
    spyOn(viewHistory, 'findView').and.callFake((startTime?: RelativeTime) =>
      startTime !== undefined ? viewByRelative[startTime as number] : undefined
    )

    startTracking(viewHistory)
    notifyConnecting()
    notifyClose(100, 1000, 'bye', true)

    const webSocket = completed[0]
    expect(webSocket.startViewId).toBe('view-start')
    expect(webSocket.endViewId).toBe('view-end')
  })

  it('flushOpenConnections finalizes still-open connections with tracking_end_reason="session_end"', () => {
    const tracker = startTracking()
    notifyConnecting()
    notifyOpen(10)
    notifyMessageIn(20, 1)

    tracker.flushOpenConnections('session_end')

    expect(completed.length).toBe(1)
    expect(completed[0].trackingEndReason).toBe('session_end')
    expect(completed[0].handshakeSucceeded).toBeTrue()
    expect(completed[0].closeCode).toBeUndefined()
    expect(completed[0].closeReason).toBeUndefined()
    expect(completed[0].wasClean).toBeUndefined()
  })

  it('does not finalize twice when close arrives after flushOpenConnections', () => {
    const tracker = startTracking()
    notifyConnecting()
    notifyOpen(10)
    tracker.flushOpenConnections('session_end')
    notifyClose(20, 1000, 'bye', true)

    expect(completed.length).toBe(1)
    expect(completed[0].trackingEndReason).toBe('session_end')
  })

  it('stop() unsubscribes from the observable and ignores further events', () => {
    const tracker = startTracking()
    notifyConnecting()
    tracker.stop()
    notifyClose(20, 1000, 'bye', true)

    expect(completed.length).toBe(0)
  })

  describe('websocket-connecting vital', () => {
    it('emits a duration-0 vital on connecting', () => {
      const addDurationVital = jasmine.createSpy<(vital: DurationVital) => void>()
      startTracking(mockViewHistory(), addDurationVital)
      notifyConnecting()

      expect(addDurationVital).toHaveBeenCalledOnceWith(
        jasmine.objectContaining({
          name: WEBSOCKET_CONNECTING_VITAL_NAME,
          type: VitalType.DURATION,
          duration: 0,
        })
      )
    })

    it('uses the same id as the subsequent WEBSOCKET_COMPLETED connectionId', () => {
      const addDurationVital = jasmine.createSpy<(vital: DurationVital) => void>()
      startTracking(mockViewHistory(), addDurationVital)
      notifyConnecting()
      notifyClose(1, 1000, 'bye', true)

      expect(addDurationVital).toHaveBeenCalledOnceWith(jasmine.objectContaining({ id: completed[0].connectionId }))
    })

    it('includes url, protocols, and startViewId in the vital context', () => {
      const viewByRelative: Record<number, ViewHistoryEntry> = {
        0: { id: 'view-start', startClocks: relativeToClocks(0 as RelativeTime) },
      }
      const viewHistory = mockViewHistory()
      spyOn(viewHistory, 'findView').and.callFake((startTime?: RelativeTime) =>
        startTime !== undefined ? viewByRelative[startTime as number] : undefined
      )
      const addDurationVital = jasmine.createSpy<(vital: DurationVital) => void>()
      const url = 'wss://example.com/socket'
      const protocols = ['chat.v1', 'json']

      startTracking(viewHistory, addDurationVital)
      notifyConnecting(0, url, undefined, protocols)

      expect(addDurationVital).toHaveBeenCalledOnceWith(
        jasmine.objectContaining({
          context: {
            url,
            protocols,
            startViewId: 'view-start',
          },
        })
      )
    })
  })

  describe('startWebSocketCollection', () => {
    const wsInstance = {} as WebSocket
    const wsUrl = 'wss://example.com/socket'

    function notifyConnectionConnecting(startRelative = 0 as RelativeTime) {
      initWebSocketObservable({}).notify({
        state: 'connecting',
        instance: wsInstance,
        url: wsUrl,
        startClocks: relativeToClocks(startRelative),
      })
    }

    it('finalizes open connections with tracking_end_reason="session_end" when the session expires', () => {
      const collection = startWebSocketCollection(
        lifeCycle,
        mockRumConfiguration(),
        mockViewHistory(),
        jasmine.createSpy()
      )
      registerCleanupTask(() => collection.stop())
      notifyConnectionConnecting()

      lifeCycle.notify(LifeCycleEventType.SESSION_EXPIRED)

      expect(completed.length).toBe(1)
      expect(completed[0].trackingEndReason).toBe('session_end')
      expect(completed[0].handshakeSucceeded).toBeFalse()
      expect(completed[0].closeCode).toBeUndefined()
      expect(completed[0].closeReason).toBeUndefined()
      expect(completed[0].wasClean).toBeUndefined()
    })

    it('finalizes open connections with tracking_end_reason="session_end" when stop() is called', () => {
      const collection = startWebSocketCollection(
        lifeCycle,
        mockRumConfiguration(),
        mockViewHistory(),
        jasmine.createSpy()
      )
      notifyConnectionConnecting()
      collection.stop()

      expect(completed.length).toBe(1)
      expect(completed[0].trackingEndReason).toBe('session_end')
      expect(completed[0].handshakeSucceeded).toBeFalse()
      expect(completed[0].closeCode).toBeUndefined()
    })

    it('ignores further WebSocket events from the same instance after stop()', () => {
      const collection = startWebSocketCollection(
        lifeCycle,
        mockRumConfiguration(),
        mockViewHistory(),
        jasmine.createSpy()
      )
      notifyConnectionConnecting()
      collection.stop()

      const eventCountAfterStop = completed.length

      // After stop(), the tracker has unsubscribed from the observable: further notifications
      // about the same instance must be ignored so we don't double-emit or leak state.
      initWebSocketObservable({}).notify({
        state: 'close',
        instance: wsInstance,
        code: 1000,
        reason: 'bye',
        wasClean: true,
        at: relativeToClocks(1000 as RelativeTime),
      })

      expect(completed.length).toBe(eventCountAfterStop)
    })
  })
})
