import { registerCleanupTask } from '../../test'
import type { Subscription } from '../tools/observable'
import type { WebSocketContext } from './webSocketObservable'
import { initWebSocketObservable, resetWebSocketObservable } from './webSocketObservable'

// A minimal stand-in for the native `WebSocket` constructor. We do not connect to a real server in
// unit tests; instead we expose helpers to simulate the browser dispatching events on the instance.
class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  url: string
  protocol = ''
  bufferedAmount = 0
  readyState: number = FakeWebSocket.CONNECTING
  onmessage: ((event: MessageEvent) => void) | null = null
  onopen: ((event: Event) => void) | null = null
  onclose: ((event: CloseEvent) => void) | null = null

  constructor(url: string | URL, protocols?: string | string[]) {
    super()
    this.url = String(url)
    if (typeof protocols === 'string') {
      this.protocol = protocols
    }
  }

  send(_data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    // no-op; tests will set `bufferedAmount` before calling send to verify it is sampled.
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = FakeWebSocket.CLOSED
  }

  simulateOpen() {
    this.readyState = FakeWebSocket.OPEN
    const event = new Event('open')
    this.dispatchEvent(event)
    this.onopen?.(event)
  }

  simulateMessage(data: unknown) {
    const event = new MessageEvent('message', { data })
    this.dispatchEvent(event)
    this.onmessage?.(event)
  }

  simulateClose(code: number, reason: string, wasClean: boolean) {
    this.readyState = FakeWebSocket.CLOSED
    // CloseEvent is not always constructable in test environments; use a plain Event with assigned fields.
    const event = Object.assign(new Event('close'), { code, reason, wasClean }) as CloseEvent
    this.dispatchEvent(event)
    this.onclose?.(event)
  }
}

const windowAsWebSocketHost = window as unknown as { WebSocket: typeof FakeWebSocket }

describe('webSocketObservable', () => {
  let originalWebSocket: typeof FakeWebSocket
  let contexts: WebSocketContext[]
  let subscription: Subscription | undefined

  beforeEach(() => {
    originalWebSocket = windowAsWebSocketHost.WebSocket
    windowAsWebSocketHost.WebSocket = FakeWebSocket
    contexts = []

    registerCleanupTask(() => {
      subscription?.unsubscribe()
      subscription = undefined
      resetWebSocketObservable()
      windowAsWebSocketHost.WebSocket = originalWebSocket
    })
  })

  function startTracking() {
    subscription = initWebSocketObservable({ allowUntrustedEvents: true }).subscribe((context) => {
      contexts.push(context)
    })
  }

  function getContexts<T extends WebSocketContext['state']>(state: T) {
    return contexts.filter((context): context is Extract<WebSocketContext, { state: T }> => context.state === state)
  }

  describe('connecting context', () => {
    it('emits a "connecting" context when a WebSocket is constructed', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')

      const connectingContexts = getContexts('connecting')
      expect(connectingContexts.length).toBe(1)
      expect(connectingContexts[0].url).toBe('wss://example.com/socket')
      expect(connectingContexts[0].instance).toBe(ws as unknown as WebSocket)
      expect(connectingContexts[0].startClocks.timeStamp).toEqual(jasmine.any(Number))
    })

    it('coerces URL objects to strings in the "connecting" context', () => {
      startTracking()

      new windowAsWebSocketHost.WebSocket(new URL('wss://example.com/socket'))

      expect(getContexts('connecting')[0].url).toBe('wss://example.com/socket')
    })

    it('does not include protocols in the "connecting" context when omitted', () => {
      startTracking()

      new windowAsWebSocketHost.WebSocket('wss://example.com/socket')

      expect(getContexts('connecting')[0].protocols).toBeUndefined()
    })

    it('includes string protocols in the "connecting" context', () => {
      startTracking()

      new windowAsWebSocketHost.WebSocket('wss://example.com/socket', 'chat.v1')

      expect(getContexts('connecting')[0].protocols).toBe('chat.v1')
    })

    it('includes array protocols in the "connecting" context', () => {
      startTracking()

      new windowAsWebSocketHost.WebSocket('wss://example.com/socket', ['chat.v1', 'json'])

      expect(getContexts('connecting')[0].protocols).toEqual(['chat.v1', 'json'])
    })
  })

  describe('preservation of native behavior', () => {
    it('preserves instanceof on the constructed instance', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')

      expect(ws instanceof windowAsWebSocketHost.WebSocket).toBeTrue()
    })

    it('preserves static members on the constructed instance', () => {
      startTracking()

      expect(FakeWebSocket.CONNECTING).toBe(0)
      expect(FakeWebSocket.OPEN).toBe(1)
      expect(FakeWebSocket.CLOSING).toBe(2)
      expect(FakeWebSocket.CLOSED).toBe(3)
    })

    it('does not clobber a customer-set onmessage handler', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      const customerHandler = jasmine.createSpy()
      ws.onmessage = customerHandler

      ws.simulateMessage('hello')

      expect(customerHandler).toHaveBeenCalledTimes(1)
      expect(getContexts('message-in').length).toBe(1)
    })

    it('does not clobber a customer-set onopen handler', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      const customerHandler = jasmine.createSpy()
      ws.onopen = customerHandler

      ws.simulateOpen()

      expect(customerHandler).toHaveBeenCalledTimes(1)
      expect(getContexts('open').length).toBe(1)
    })

    it('does not clobber a customer-set onclose handler', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      const customerHandler = jasmine.createSpy()
      ws.onclose = customerHandler

      ws.simulateClose(1000, 'bye', true)

      expect(customerHandler).toHaveBeenCalledTimes(1)
      expect(getContexts('close').length).toBe(1)
    })
  })

  describe('open context', () => {
    it('emits an "open" context when the WebSocket opens', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.protocol = 'chat.v1'
      ws.simulateOpen()

      const openContexts = getContexts('open')
      expect(openContexts.length).toBe(1)
      expect(openContexts[0].protocol).toBe('chat.v1')
      expect(openContexts[0].instance).toBe(ws as unknown as WebSocket)
      expect(openContexts[0].openClocks.timeStamp).toEqual(jasmine.any(Number))
    })

    it('emits an "open" context with empty protocol when no sub-protocol negotiated', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.simulateOpen()

      const openContexts = getContexts('open')
      expect(openContexts.length).toBe(1)
      expect(openContexts[0].protocol).toBe('')
    })
  })

  describe('message-in context', () => {
    it('emits "message-in" with byte-length size for string payloads', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.simulateOpen()
      ws.simulateMessage('hello world')

      const messageInContexts = getContexts('message-in')
      expect(messageInContexts.length).toBe(1)
      expect(messageInContexts[0].size).toBe('hello world'.length)
    })

    it('emits "message-in" with UTF-8 byte length for multi-byte strings', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.simulateOpen()
      // 'é' is 2 bytes in UTF-8 and 'あ' is 3 bytes; total is 5 bytes for 2 chars
      ws.simulateMessage('éあ')

      expect(getContexts('message-in')[0].size).toBe(5)
    })

    it('emits "message-in" with byteLength for ArrayBuffer payloads', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.simulateOpen()
      ws.simulateMessage(new ArrayBuffer(16))

      expect(getContexts('message-in')[0].size).toBe(16)
    })

    it('emits "message-in" with byteLength for ArrayBufferView payloads', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.simulateOpen()
      ws.simulateMessage(new Uint8Array(new ArrayBuffer(32), 4, 12))

      expect(getContexts('message-in')[0].size).toBe(12)
    })

    it('emits "message-in" with size for Blob payloads', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.simulateOpen()
      const blob = new Blob(['hello'])
      ws.simulateMessage(blob)

      expect(getContexts('message-in')[0].size).toBe(blob.size)
    })
  })

  describe('message-out context', () => {
    it('emits "message-out" with size and bufferedAmountPreSend for string payloads', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.bufferedAmount = 42
      ws.send('hello')

      const messageOutContexts = getContexts('message-out')
      expect(messageOutContexts.length).toBe(1)
      expect(messageOutContexts[0].size).toBe(5)
      expect(messageOutContexts[0].bufferedAmountPreSend).toBe(42)
      expect(messageOutContexts[0].at.timeStamp).toEqual(jasmine.any(Number))
    })

    it('emits "message-out" with byteLength for ArrayBuffer payloads', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.send(new ArrayBuffer(8))

      expect(getContexts('message-out')[0].size).toBe(8)
    })

    it('emits "message-out" with byteLength for ArrayBufferView payloads', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.send(new Uint8Array(new ArrayBuffer(20), 2, 10))

      expect(getContexts('message-out')[0].size).toBe(10)
    })

    it('emits "message-out" with size for Blob payloads', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      const blob = new Blob(['hello world'])
      ws.send(blob)

      expect(getContexts('message-out')[0].size).toBe(blob.size)
    })
  })

  describe('close context', () => {
    it('emits a "close" context with code, reason, and wasClean', () => {
      startTracking()

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.simulateClose(1000, 'bye', true)

      const closeContexts = getContexts('close')
      expect(closeContexts.length).toBe(1)
      expect(closeContexts[0].code).toBe(1000)
      expect(closeContexts[0].reason).toBe('bye')
      expect(closeContexts[0].wasClean).toBeTrue()
      expect(closeContexts[0].at.timeStamp).toEqual(jasmine.any(Number))
    })
  })

  describe('subscription lifecycle', () => {
    it('restores the native WebSocket constructor when all subscribers unsubscribe', () => {
      startTracking()
      subscription?.unsubscribe()
      subscription = undefined

      expect(windowAsWebSocketHost.WebSocket).toBe(FakeWebSocket)
    })

    it('does not emit any further events after all subscribers unsubscribe', () => {
      startTracking()
      subscription?.unsubscribe()
      subscription = undefined

      const ws = new windowAsWebSocketHost.WebSocket('wss://example.com/socket')
      ws.simulateOpen()
      ws.send('hello')

      expect(contexts.length).toBe(0)
    })
  })
})
