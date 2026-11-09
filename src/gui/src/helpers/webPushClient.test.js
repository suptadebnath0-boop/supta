/*
 * Copyright (C) 2024-present Puter Technologies Inc.
 *
 * This file is part of Puter.
 *
 * Puter is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { describe, expect, it, vi } from 'vitest';
import { registerPushClient } from './pushClient.js';
import { syncBrowserPush } from './pushSync.js';
import { webPushClient } from './webPushClient.js';

const SCOPE = 'https://puter.test/';
const CHANGED = `puter:subscription-changed:${SCOPE}`;

/** IndexedDB with one store's worth of entries, answering on a microtask. */
const fakeIdb = (entries = {}) => {
    const map = new Map(Object.entries(entries));
    const later = (run) => {
        const req = {};
        queueMicrotask(() => {
            req.result = run();
            req.onsuccess?.();
        });
        return req;
    };
    const store = {
        get: (key) => later(() => map.get(key)),
        delete: (key) => later(() => void map.delete(key)),
    };
    return {
        map,
        open: () => later(() => ({ transaction: () => ({ objectStore: () => store }), close: () => {} })),
    };
};

const make = ({ on = true, devices = [], permission = 'granted', subscription = { endpoint: 'https://push.example/1' }, state = 'active', idb = fakeIdb() } = {}) => {
    const notifications = {
        enable: vi.fn(async () => on),
        disable: vi.fn(async () => true),
        listDevices: vi.fn(async () => devices),
    };
    const nav = {
        serviceWorker: {
            getRegistration: vi.fn(async () => ({ scope: SCOPE, pushManager: { getSubscription: async () => subscription } })),
        },
    };
    const endpointState = vi.fn(async () => state);
    return { notifications, endpointState, idb, client: webPushClient({ notifications, NotificationApi: { permission }, nav, idb, endpointState }) };
};

const current = { uid: 'd1', platform: 'webpush', current: true };

describe('webPushClient', () => {
    it('calls enable() before anything is awaited, and returns this browser`s device', async () => {
        const { notifications, client } = make({ devices: [{ uid: 'x', platform: 'web', current: true }, current] });
        const pending = client.enable();
        expect(notifications.enable).toHaveBeenCalledTimes(1);
        await expect(pending).resolves.toEqual({ deviceUid: 'd1' });
    });

    it('rejects when the browser said no', async () => {
        const { client } = make({ on: false, permission: 'denied' });
        await expect(client.enable()).rejects.toThrow('notifications denied');
    });

    it('is registered only with a subscription the server lists for this session', async () => {
        await expect(make({ devices: [current] }).client.status()).resolves.toEqual({ permission: 'granted', registered: true, deviceUid: 'd1' });
        await expect(make({ devices: [] }).client.status()).resolves.toEqual({ permission: 'granted', registered: false });
        await expect(make({ subscription: null, devices: [current] }).client.status()).resolves.toEqual({ permission: 'granted', registered: false });
        await expect(make({ permission: 'denied' }).client.status()).resolves.toEqual({ permission: 'denied', registered: false });
    });

    it('is registered only while the server has this subscription`s endpoint', async () => {
        const { client, endpointState } = make({ devices: [current], state: 'unknown' });
        await expect(client.status()).resolves.toEqual({ permission: 'granted', registered: false });
        expect(endpointState).toHaveBeenCalledWith('https://push.example/1');
        await expect(make({ devices: [current], state: 'removed' }).client.status()).resolves.toEqual({ permission: 'granted', registered: false });
        // A server that can't tell leaves the session match.
        await expect(make({ devices: [current], state: null }).client.status()).resolves.toEqual({ permission: 'granted', registered: true, deviceUid: 'd1' });
    });

    it('is not registered once the worker marked the subscription replaced, until enable() registers it', async () => {
        const idb = fakeIdb({ [CHANGED]: 1 });
        const { client, endpointState } = make({ devices: [current], idb });
        await expect(client.status()).resolves.toEqual({ permission: 'granted', registered: false });
        expect(endpointState).not.toHaveBeenCalled();

        await expect(client.enable()).resolves.toEqual({ deviceUid: 'd1' });
        expect(idb.map.has(CHANGED)).toBe(false);
        await expect(client.status()).resolves.toEqual({ permission: 'granted', registered: true, deviceUid: 'd1' });
    });

    it('has the next load register a replaced subscription in full', async () => {
        globalThis.gui_params = { pushEnabled: true };
        const { client, notifications } = make({ devices: [current], idb: fakeIdb({ [CHANGED]: 1 }) });
        registerPushClient(client);
        const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
        await expect(syncBrowserPush({}, { NotificationApi: { permission: 'granted' }, userUid: 'u-1', storage, holdsPush: async () => true })).resolves.toBe('on');
        expect(notifications.enable).toHaveBeenCalledTimes(1);
    });

    it('turns off through puter.notifications', async () => {
        const { notifications, client } = make();
        await client.disable();
        expect(notifications.disable).toHaveBeenCalled();
    });
});
