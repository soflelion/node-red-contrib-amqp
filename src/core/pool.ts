import toHash from 'object-hash';
import { Connection } from './connection';
import { ConnectionSettings } from './settings';

const POOL = {} as {
    [uri: string]: Connection;
};

export function open(settings: ConnectionSettings): Connection {
    const hash = toHash(settings);
    let conn = POOL[hash];

    if (!conn) {
        conn = new Connection(settings);

        POOL[hash] = conn;
    }

    return conn;
}

export async function close(settings: ConnectionSettings): Promise<void> {
    const hash = toHash(settings);
    const conn = POOL[hash];

    if (!conn) {
        return Promise.resolve();
    }

    delete POOL[hash];

    (await conn).close();
}
