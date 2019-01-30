// @flow
import WebSocket from 'ws';
import type { MessageEvent } from 'ws';
import _ from 'lodash';
import EventEmitter from 'event-emitter-es6';
import MonotonicNow from 'monotonic-timestamp';
import uuidv4 from 'uuid/v4';

import * as Utils from './utils';

type DataQueue = AsyncQueue<string>;

const WS_STATE = {
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
};

export default class Client {
    emitter: EventEmitter = new EventEmitter({ emitDelay: 0});
    ws: WebSocket;
    convos: Map<string, Convo> = new Map();
    queues: Map<string, DataQueue> = new Map();

    // TODO: Make construction here less akward
    constructor(url: string | () => string, socketCreator: ?(string) => WebSocket = null) {
        this.ws = null;

        let _url: string;

        if (typeof url === 'string') {
            _url = url;
        }
        else if (typeof url === 'function') {
            _url = url();
        }
        else {
            throw new Error('Url parameter must be string or function');
        }

        this.ws = socketCreator ? socketCreator(_url) : new WebSocket(_url);

        this.ws.addEventListener('message', this.handleMessage.bind(this));
        this.ws.addEventListener('open', this.handleOpen.bind(this));
        this.ws.addEventListener('close', this.handleClose.bind(this));
        this.ws.addEventListener('error', this.handleError.bind(this));
    }

    handleOpen(event: Event) {
        console.info('Connection socket opened, state:', this.ws.readyState);
        this.emitter.emit('open', event);
    }

    handleError(event: Event) {
        console.error('Connection socket error occurred');
        this.emitter.emit('error', event);
    }

    handleClose(event: Event) {
        // console.info('Connection Socket closed', data);
        this.emitter.emit('close', event);
    }

    handleMessage(event: MessageEvent) {
        // this.emit('message', data);
        this._parseMessage(event.data);
    }

    static _extract_guid(obj: Object) {
        return _.get(obj, 'response_id', null) || _.get(obj, 'error_data.response_id', null);
    }

    _parseMessage(data: string) {
        try {
            const obj = JSON.parse(data);
            if (typeof obj !== 'object') {
                throw new Error(`Expecting object not "${JSON.stringify(obj)}"`)
            }
            const guid = Client._extract_guid(obj);

            const convo: ?Convo = this.convos.get(guid) || null;

            let queue = this.queues.get(guid);

            if (!queue) {
                this.queues.set(guid, queue = new AsyncQueue());
            }

            queue.put(obj);
        }
        catch (e) {
            console.error('Error parsing message:', e);
        }
    }

    async getMessageAsync(guid: string) {
        let queue: ?DataQueue = this.queues.get(guid);

        if (!queue) {
            this.queues.set(guid, queue = new AsyncQueue());
        }

        return queue.getAsync();
    }

    async send(data: Object, timeout: number=2000) {
        const json = JSON.stringify(data);
        const state = this.ws.readyState;

        switch (state) {
            case WS_STATE.CONNECTING:
                console.log('Socket still opening, waiting to send', data);

                await this.wait('open', timeout).catch(data => { throw new Error(data); });
                break;

            case WS_STATE.OPEN:
                break;

            case WS_STATE.CLOSED:
            case WS_STATE.CLOSING:
                throw new Error('Socket is closing or closed!');

            default:
                throw Error('Unknown state ' + JSON.stringify(state));
        }

        console.log('Sending', data);

        return this.ws.send(json);
    }

    async convo(actionName: string, asyncAction: (Convo, string) => Promise<void>) {
        const guid = uuidv4();
        const convo = new Convo(this, actionName, guid);

        this.convos.set(guid, convo);

        const maybePromise = asyncAction(convo, guid);

        if (!maybePromise instanceof Promise) {
            throw new Error('asyncAction must be promise/async');
        }

        try {
            const result = await maybePromise;
        }
        catch (e) {
            console.error(`Error occurred while in convo for ${actionName}:${guid}: ${e}`)
            throw e;
        }
        finally {
            this.convos.delete(guid);
            const queue: ?DataQueue = this.queues.get(guid);

            if (queue) {
                queue.close();
                this.queues.delete(guid);
            }
        }
    }

    async close(code:number = 1000, reason: string = '') {
        return this.ws.close(code, reason);
    }

    wait(eventName: string, timeout: number) : Promise<any> {
        let unsub: ?() => void = null;

        return Utils.timeboxPromise(new Promise((resolve, reject) => {
                unsub = this.emitter.once(eventName, resolve);
            }),
            timeout,
            () => {
                if (unsub) {
                    unsub();
                }
            }
        );
    }
}

export class AsyncQueue<T> {
    _deferred: ?Utils.Deferred<T> = null;
    _items: Array<T> = [];

    put(data: T) {
        if (this._deferred) {
            this._deferred.resolve(data);
            this._deferred = null;
        } else {
            this._items.push(data);
        }
    }

    close() {
        if (this._deferred) {
            this._deferred.reject(new Error('AsyncQueue closing'));
            this._deferred = null;
        }
    }

    async getAsync() {
        if (this._deferred !== null) {
            throw new Error('AsyncQueue.get() already blocking');
        }

        if (this._items.length > 0) {
            return this._items.shift();
        }

        this._deferred = Utils.createDeferred();

        return this._deferred.promise;
    }

    get length() {
        return this._items.length;
    }
}

export class Convo {
    client: Client;
    guid: string;
    action: string;
    startTimestamp: number;

    constructor(client: Client, action: string, guid: string) {
        this.client         = client;
        this.guid           = guid;
        this.action         = action;
        this.startTimestamp = MonotonicNow();
    }

    async expect(timeout: number = 5000.0) {
        return Utils.timeboxPromise(this.client.getMessageAsync(this.guid), timeout);
    }

    async send(data: Object) {
        return this.client.send({
            ...data,
            action: this.action,
            response_id: this.guid,
        });
    }

    async sendAndExpect(data: Object, timeout: number = 5000.0) {
        await this.send(data);
        return this.expect(timeout);
    }
}
