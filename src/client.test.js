// @flow
import WebSocket from 'ws'
import Client, { AsyncQueue, Convo } from './client';
import * as Utils from './utils';

async function expectThrow(
    asyncFunc: Promise<any>,
    matchers: {instanceOf?: Class<*>, matches?: RegExp} = {}
) : Promise<void> {
    let error: any = null;

    try {
        await asyncFunc;
        expect(false).toBe('To have thrown something');
    }
    catch (e) {
        error = e;
    }

    expect(error).toBeTruthy();

    if (matchers.instanceOf) {
        expect(error instanceof matchers.instanceOf).toBe(true);
    }
    if (matchers.matches) {
        expect(matchers.matches.test(String(error))).toBeTruthy();
    }
}

function timeoutPromise(resolveValue, time) {
    return new Promise(resolve => setTimeout(() => resolve(resolveValue), time));
}

async function sleep(time) {
    return timeoutPromise(true, time);
}

class MockClient {
    sends: Array<string> = [];
    gets: Array<string> = [];
    getMessageAsync: (guid: string) => Promise<?string>;
    send: (data: string) => void;

    constructor() {
        this.getMessageAsync = this._getMessageAsync;
        this.send = this._send;
    }

    reset() {
        this.sends = [];
        this.gets = [];
        this.getMessageAsync = this._getMessageAsync;
        this.send = this._send;
    }

    _getMessageAsync: string => Promise<string> = async (guid: string) => {
        return this.gets.shift();
    };

    _send: string => void = (data: string) => {
        this.sends.push(data);
    }
}

describe('timeboxPromise', () => {
    it('times out', async () => {
        await expectThrow(
            Utils.timeboxPromise(timeoutPromise('yo', 200), 180),
            { instanceOf: Utils.TimeboxTimeout }
        );
    });

    it('resolves in time', async () => {
        await expect(Utils.timeboxPromise(timeoutPromise('yo', 180), 200)).resolves.toBe('yo');
    });
});

describe('AsyncQueue', () => {
    it('gets one item', async () => {
        const queue = new AsyncQueue();

        queue.put('foo');

        expect(await queue.getAsync()).toBe('foo');
    });

    it('gets several items', async () => {
        const queue = new AsyncQueue();

        const items = [ 'foo', 'foo2', 'foo3' ];

        items.forEach(item => queue.put(item));
        items.forEach(async item => expect(await queue.getAsync()).toBe(item));
    });

    it('gets one item after a 50ms', async () => {
        const queue = new AsyncQueue();

        setTimeout(() => queue.put('hello!'), 50);

        expect(await queue.getAsync()).toBe('hello!');
    });

    it('gets a bunch of items and gets one more later after 50ms', async () => {
        const queue = new AsyncQueue();

        const items = [ 'foo', 'foo2', 'foo3' ];

        items.forEach(item => queue.put(item));
        items.forEach(async item => expect(await queue.getAsync()).toBe(item));


        setTimeout(() => queue.put('hello!'), 50);
        expect(await queue.getAsync()).toBe('hello!');
    });

    it('gets a few items 10ms each', async () => {
        const queue = new AsyncQueue();

        const items = ['foo', 'foo2', 'foo3'];

        (async () => {
            for (let i = 0, item; i < items.length; ++i) {
                item = items[i];
                await sleep(10);
                queue.put(item);
            }
        })();

        for (let i = 0, item; i < items.length; ++i) {
            item = items[i];
            expect(await queue.getAsync()).toBe(item);
        }
    });

    it('starve queue for 50ms', async () => {
        const queue = new AsyncQueue();

        const items = ['foo', 'foo2', 'foo3'];

        queue.put(items[0]);
        queue.put(items[1]);

        (async () => {
            await sleep(50);
            queue.put(items[2]);
        })();

        expect(await queue.getAsync()).toBe(items[0]);
        expect(await queue.getAsync()).toBe(items[1]);

        await expectThrow(
            Utils.timeboxPromise((async () => {
                expect(await queue.getAsync()).toBe(items[2]);
            })(), 45),
            { instanceOf: Utils.TimeboxTimeout },
        );
    });
});

describe('Convo', () => {
    const uuid = '123F00';

    const client = new MockClient();

    beforeEach(() => client.reset());

    it('sends and expects a message successfully', async () => {
        const convo = new Convo((client: any), 'test_action', uuid);

        client.gets.push('hello');

        await (async convo => {
             expect(await convo.sendAndExpect({msg: 'yo'})).toBe('hello');
        })(convo);

        expect(client.sends).toContainEqual(
            expect.objectContaining({
                action: 'test_action',
                msg: 'yo',
                response_id: uuid,
            })
        );
    });

    it('times out on an expect', async () => {
        const convo = new Convo((client: any), 'test_action', uuid);

        client.gets.push('not suppose to get this');

        client.getMessageAsync = async guid => {
            await sleep(70);
            return null;
        };

        await expectThrow(convo.sendAndExpect({msg: 'hey'}, 50), {
            instanceOf: Utils.TimeboxTimeout
        });
    });
});

describe('Client', () => {

    class MockSocket {
        sends: Array<string> = [];
        onmessage: (Object) => void;
        onopen: (Object) => void;
        onclose: (Object) => void;
        onerror: (Object) => void;
        readyState: string;

        constructor(url) {
            const notImpl = () => { throw new Error('Not implemented'); };

            this.onmessage = notImpl;
            this.onopen = notImpl;
            this.onclose = notImpl;
            this.onerror = notImpl;
            this.readyState = WebSocket.CONNECTING;
        }

        send(data) {
            console.log('Mock socket send():', data);
            this.sends.push(data);
        }

        addEventListener(event, fn) {
            (this: any)[`on${event}`] = fn;
        }

        mockServerSend(data) {
            console.log('mockServerSend():', data);
            this.onmessage({data});
        }

        mockConnect() {
            this.readyState = WebSocket.OPEN;
            this.onopen({});
        }

        getAllDecodedSends() {
            const results = [];
            this.sends.forEach(msg => results.push(JSON.parse(msg)));

            return results;
        }

        popDecoded() {
            if (this.sends.length === 0) {
                return null;
            }

            const top = this.sends.pop();
            return JSON.parse(top);
        }
    }

    it('delays connection for 10ms and sends message', async () => {
        const mockSocket = new MockSocket();
        const client = new Client('whatever', () => mockSocket);

        const promise = Utils.timeboxPromise(
            (async () => {
                const data = {data: 'yo'};

                await client.send(data);
                expect(mockSocket.getAllDecodedSends()).toEqual([data]);
            })(),
            20
        );

        await sleep(10);

        mockSocket.mockConnect();

        await promise;
    });

    it('has a conversation', async () => {
        const mockSocket = new MockSocket();
        const client = new Client('whatever', () => mockSocket);

        await client.convo('foo', async (convo, guid) => {
            let promise;
            let data = {data: 'hey'};

            mockSocket.mockConnect();

            promise = convo.sendAndExpect(data, 200);

            // Wait a while to so we get the hey
            await sleep(5);

            expect(mockSocket.popDecoded()).toEqual(expect.objectContaining(data));

            data = {hello: 'hi', response_id: guid};
            mockSocket.mockServerSend(JSON.stringify(data));

            expect(await promise).toEqual(expect.objectContaining(data));
        });
    });

    it('expects multiple messages', async () => {
        const mockSocket = new MockSocket();
        const client = new Client('whatever', () => mockSocket);

        await client.convo('bar', async (convo, guid) => {
            let data = ['omae', 'wa', 'moe', 'shinderu'];

            mockSocket.mockConnect();

            const promise = (async () => {
                for (let i = 0; i< data.length; ++i) {
                    await sleep(5);
                    mockSocket.mockServerSend(JSON.stringify({data: data[i], response_id: guid}));
                }
            })();

            for (let i = 0; i< data.length; ++i) {
                expect(await convo.expect(10)).toEqual({data: data[i], response_id: guid});
            }

            // In case the async function threw any errors.
            await promise;
         });
    });
});
