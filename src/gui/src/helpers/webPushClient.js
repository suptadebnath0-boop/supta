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

// Puter's own push client: standard Web Push through `/sw.js` via `puter.notifications`, used when the server publishes `pushWebPushKey`.

import { forgetPushApps, webPushEndpointState } from './notificationApi.js';

/** The GUI's worker, as `puter.notifications` registers it. */
const GUI_WORKER = { url: '/sw.js', scope: '/' };

/** What `/sw.js` posts when the browser replaced the subscription. */
const SUBSCRIPTION_CHANGED_MESSAGE = 'puter-push-subscription-changed';

// Where `/sw.js` marks a subscription the browser replaced, as puter.js's pushStore.js does.
const DB_NAME = 'puter-push';
const HANDLERS = 'handlers';
const CLICKS = 'clicks';
export const SUBSCRIPTION_CHANGED_PREFIX = 'puter:subscription-changed:';

/** The endpoint the server last confirmed for this browser, in `localStorage`. */
export const LAST_ENDPOINT_KEY = 'puter.push.last-endpoint';

const removedError = () => Object.assign(new Error('this browser was removed from push in Puter'), { code: 'push_device_removed' });

/** Runs one request on the handlers store. @param {IDBFactory} idb @param {IDBTransactionMode} mode @param {(store: IDBObjectStore) => IDBRequest} action */
const handlersStore = (idb, mode, action) => new Promise((resolve, reject) => {
    const open = idb.open(DB_NAME, 1);
    open.onupgradeneeded = () => {
        open.result.createObjectStore(HANDLERS);
        open.result.createObjectStore(CLICKS);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
        const db = open.result;
        try {
            const req = action(db.transaction(HANDLERS, mode).objectStore(HANDLERS));
            req.onsuccess = () => {
                db.close();
                resolve(req.result);
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        } catch ( e ) {
            db.close();
            reject(e);
        }
    };
});

/** @returns {import('./pushClient.js').PushClient} */
export const webPushClient = ({
    notifications = globalThis.puter?.notifications,
    NotificationApi = globalThis.Notification,
    nav = globalThis.navigator,
    userUid = () => globalThis.user?.uuid,
    idb = globalThis.indexedDB,
    endpointState = webPushEndpointState,
    storage = globalThis.localStorage,
} = {}) => {
    // The last `on` this page read; a new page always asks the server.
    /** @type {{ userUid: string, endpoint: string, deviceUid: string }|null} */
    let lastOn = null;
    let generation = 0;
    const forgetOn = () => {
        lastOn = null;
        generation++;
    };
    /** The real check in flight, shared by every read of the same user and endpoint. */
    let checking = null;
    const check = (user, endpoint) => {
        const key = `${generation}\n${user ?? ''}\n${endpoint}`;
        if ( checking?.key === key ) return checking.promise;
        const entry = { key, promise: null };
        entry.promise = Promise.all([currentDevice(), endpointState(endpoint)]).finally(() => {
            if ( checking === entry ) checking = null;
        });
        checking = entry;
        return entry.promise;
    };
    nav?.serviceWorker?.addEventListener?.('message', (event) => {
        if ( event.data?.type === SUBSCRIPTION_CHANGED_MESSAGE ) forgetOn();
    });

    const currentDevice = async () => {
        const devices = await notifications.listDevices();
        return devices.find((d) => d.current && d.platform === 'webpush') ?? null;
    };
    const registration = async () => await nav.serviceWorker?.getRegistration('/');
    /** The worker's mark for a replaced subscription, else null. */
    const marker = async (scope) => {
        try {
            return (await handlersStore(idb, 'readonly', (s) => s.get(SUBSCRIPTION_CHANGED_PREFIX + scope))) ?? null;
        } catch ( e ) {
            return null;
        }
    };
    const rememberEndpoint = (endpoint) => {
        try {
            storage.setItem(LAST_ENDPOINT_KEY, endpoint);
        } catch ( e ) {
            // Only the removed-elsewhere check below reads it.
        }
    };
    const lastEndpoint = () => {
        try {
            return storage.getItem(LAST_ENDPOINT_KEY);
        } catch ( e ) {
            return null;
        }
    };
    const clearChanged = async () => {
        try {
            const scope = (await registration())?.scope;
            if ( scope ) await handlersStore(idb, 'readwrite', (s) => s.delete(SUBSCRIPTION_CHANGED_PREFIX + scope));
        } catch ( e ) {
            // The next load registers again.
        }
    };
    /** Whether the server says the user removed this browser's last known endpoint; if so, ends the subscription here. */
    const removedElsewhere = async () => {
        const worker = await registration();
        const mark = worker?.scope ? await marker(worker.scope) : null;
        const previous = typeof mark?.oldEndpoint === 'string' ? mark.oldEndpoint : lastEndpoint();
        if ( ! previous || await endpointState(previous) !== 'removed' ) return false;
        try {
            await (await worker?.pushManager?.getSubscription())?.unsubscribe();
        } catch ( e ) {
            // The next background run asks again.
        }
        await clearChanged();
        return true;
    };
    return {
        // Not async before `enable()`: it asks the browser inside the click.
        enable: ({ background = false } = {}) => {
            forgetOn();
            forgetPushApps();
            const turningOn = background
                ? removedElsewhere().then(async (removed) => {
                    if ( removed ) throw removedError();
                    await notifications._enableWebPush(GUI_WORKER, { renewRemoved: false });
                    return true;
                })
                : notifications.enable();
            return turningOn.then(async (on) => {
                if ( ! on ) throw new Error(`notifications ${NotificationApi?.permission ?? 'unavailable'}`);
                const device = await currentDevice();
                if ( ! device ) throw new Error('this browser was not registered');
                await clearChanged();
                const subscription = await (await registration())?.pushManager?.getSubscription();
                if ( subscription?.endpoint ) rememberEndpoint(subscription.endpoint);
                return { deviceUid: device.uid };
            });
        },
        disable: async () => {
            forgetOn();
            forgetPushApps();
            try {
                await notifications.disable();
            } finally {
                forgetOn();
            }
        },
        status: async ({ cached = false } = {}) => {
            const permission = NotificationApi?.permission ?? 'default';
            const worker = await registration();
            const subscription = await worker?.pushManager?.getSubscription();
            if ( permission !== 'granted' || ! subscription ) {
                forgetOn();
                return { permission, registered: false };
            }
            // A subscription the browser replaced is registered again in full.
            if ( await marker(worker.scope) != null ) {
                forgetOn();
                return { permission, registered: false };
            }
            const user = userUid();
            if ( cached && lastOn && lastOn.userUid === user && lastOn.endpoint === subscription.endpoint ) {
                return { permission, registered: true, deviceUid: lastOn.deviceUid };
            }
            const reading = generation;
            // Devices match by session, so the endpoint tells whether it is this subscription.
            const [device, state] = await check(user, subscription.endpoint);
            const registered = !! device && (state === 'active' || state === null);
            if ( registered && state === 'active' ) rememberEndpoint(subscription.endpoint);
            if ( reading === generation ) {
                // Only an `on` the server confirmed for this endpoint is kept.
                lastOn = registered && state === 'active' && user
                    ? { userUid: user, endpoint: subscription.endpoint, deviceUid: device.uid }
                    : null;
            }
            return registered
                ? { permission, registered: true, deviceUid: device.uid }
                : { permission, registered: false };
        },
    };
};
