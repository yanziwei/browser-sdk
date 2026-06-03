import { instrumentMethod } from '../tools/instrumentMethod'
import { Observable } from '../tools/observable'
import type { ClocksState } from '../tools/utils/timeUtils'
import { clocksNow } from '../tools/utils/timeUtils'
import type { GlobalObject } from '../tools/globalObject'
import { globalObject } from '../tools/globalObject'
import { addEventListener } from './addEventListener'

interface WebSocketObservableConfiguration {
  allowUntrustedEvents?: boolean | undefined
}

type GlobalWithWebSocket = GlobalObject & { WebSocket: typeof WebSocket }

function isGlobalWithWebSocket(global: GlobalObject): global is GlobalWithWebSocket {
  return typeof (global as { WebSocket?: unknown }).WebSocket === 'function'
}

export interface WebSocketConnectingContext {
  state: 'connecting'
  instance: WebSocket
  url: string
  protocols?: string | string[]
  startClocks: ClocksState
}

export interface WebSocketOpenContext {
  state: 'open'
  instance: WebSocket
  openClocks: ClocksState
  protocol: string
}

export interface WebSocketMessageInContext {
  state: 'message-in'
  instance: WebSocket
  size: number
  at: ClocksState
}

export interface WebSocketMessageOutContext {
  state: 'message-out'
  instance: WebSocket
  size: number
  bufferedAmountPreSend: number
  at: ClocksState
}

export interface WebSocketCloseContext {
  state: 'close'
  instance: WebSocket
  code: number
  reason: string
  wasClean: boolean
  at: ClocksState
}

export type WebSocketContext =
  | WebSocketConnectingContext
  | WebSocketOpenContext
  | WebSocketMessageInContext
  | WebSocketMessageOutContext
  | WebSocketCloseContext

let webSocketObservable: Observable<WebSocketContext> | undefined

export function initWebSocketObservable(configuration: WebSocketObservableConfiguration): Observable<WebSocketContext> {
  if (!webSocketObservable) {
    webSocketObservable = createWebSocketObservable(configuration)
  }
  return webSocketObservable
}

function createWebSocketObservable(configuration: WebSocketObservableConfiguration) {
  return new Observable<WebSocketContext>((observable) => {
    if (!isGlobalWithWebSocket(globalObject)) {
      return undefined
    }

    const stopListeners: Array<() => void> = []

    const { stop: stopInstrumentingConstructor } = instrumentMethod(
      globalObject,
      'WebSocket',
      ({ parameters, onPostCall }) => {
        const url = String(parameters[0])
        const protocols = parameters[1]
        const startClocks = clocksNow()
        onPostCall((instance) => {
          observable.notify({
            state: 'connecting',
            instance,
            url,
            ...(protocols !== undefined ? { protocols } : {}),
            startClocks,
          })
          attachInstanceListeners(configuration, instance, observable, stopListeners)
        })
      }
    )

    const { stop: stopInstrumentingSend } = instrumentMethod(
      globalObject.WebSocket.prototype,
      'send',
      ({ target: instance, parameters: [data], onPostCall }) => {
        const size = computePayloadSize(data)
        const bufferedAmountPreSend = instance.bufferedAmount
        onPostCall(() => {
          observable.notify({
            state: 'message-out',
            instance,
            size,
            bufferedAmountPreSend,
            at: clocksNow(),
          })
        })
      }
    )

    return () => {
      stopInstrumentingConstructor()
      stopInstrumentingSend()
      stopListeners.forEach((stop) => stop())
      stopListeners.length = 0
    }
  })
}

function attachInstanceListeners(
  configuration: WebSocketObservableConfiguration,
  instance: WebSocket,
  observable: Observable<WebSocketContext>,
  stopListeners: Array<() => void>
) {
  const { stop: stopOpen } = addEventListener(configuration, instance, 'open', () => {
    observable.notify({
      state: 'open',
      instance,
      openClocks: clocksNow(),
      protocol: instance.protocol || '',
    })
  })
  const { stop: stopMessage } = addEventListener(configuration, instance, 'message', (event) => {
    observable.notify({
      state: 'message-in',
      instance,
      size: computePayloadSize(event.data),
      at: clocksNow(),
    })
  })
  const { stop: stopClose } = addEventListener(configuration, instance, 'close', (event) => {
    observable.notify({
      state: 'close',
      instance,
      code: event.code,
      reason: event.reason,
      wasClean: event.wasClean,
      at: clocksNow(),
    })
  })

  stopListeners.push(stopOpen, stopMessage, stopClose)
}

function computePayloadSize(data: unknown): number {
  if (typeof data === 'string') {
    return new TextEncoder().encode(data).byteLength
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength
  }
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return data.size
  }
  return 0
}

/**
 * Reset the WebSocket observable global state. Test-only.
 *
 * @internal
 */
export function resetWebSocketObservable() {
  webSocketObservable = undefined
}
