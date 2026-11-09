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

import { webPushEndpointState } from './notificationApi.js';

/** The GUI's worker, as `puter.notifications` registers it. */
const GUI_WORKER = { url: '/sw.js', scope: '/' };

/** What `/sw.js` posts when the browser replaced the subscription. */
const SUBSCRIPTION_CHANGED_MESSAGE = 'puter-push-subscription-changed';

// Where `/sw.js` marks a subscription the browser replaced, as puter.js's pushStore.js does.
const DB_NAME = 'puter-push';
const HANDLERS = 'handlers';
const CLICKS = 'clicks';
export const SUBSCRIPTION_CHANGED_PREFIX = 'puter:subscription-changed:';

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
} = {}) => {
    // The last `on` this page read; a new page always asks the server.
    /** @type {{ userUid: string, endpoint: string, deviceUid: string }|null} */
    let lastOn = null;
    let generation = 0;
    const forgetOn = () => {
        lastOn = null;
        generation++;
    };
    nav?.serviceWorker?.addEventListener?.('message', (event) => {
        if ( event.data?.type === SUBSCRIPTION_CHANGED_MESSAGE ) forgetOn();
    });

    const currentDevice = async () => {
        const devices = await notifications.listDevices();
        return devices.find((d) => d.current && d.platform === 'webpush') ?? null;
    };
    const registration = async () => await nav.serviceWorker?.getRegistration('/');
    const changed = async (scope) => {
        try {
            return (await handlersStore(idb, 'readonly', (s) => s.get(SUBSCRIPTION_CHANGED_PREFIX + scope))) != null;
        } catch ( e ) {
            return false;
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
    return {
        // Not async before `enable()`: it asks the browser inside the click.
        enable: ({ background = false } = {}) => {
            forgetOn();
            const turningOn = background
                ? notifications._enableWebPush(GUI_WORKER, { renewRemoved: false }).then(() => true)
                : notifications.enable();
            return turningOn.then(async (on) => {
                if ( ! on ) throw new Error(`notifications ${NotificationApi?.permission ?? 'unavailable'}`);
                const device = await currentDevice();
                if ( ! device ) throw new Error('this browser was not registered');
                await clearChanged();
                return { deviceUid: device.uid };
            });
        },
        disable: async () => {
            forgetOn();
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
            if ( await changed(worker.scope) ) {
                forgetOn();
                return { permission, registered: false };
            }
            const user = userUid();
            if ( cached && lastOn && lastOn.userUid === user && lastOn.endpoint === subscription.endpoint ) {
                return { permission, registered: true, deviceUid: lastOn.deviceUid };
            }
            const reading = generation;
            // Devices match by session, so the endpoint tells whether it is this subscription.
            const [device, state] = await Promise.all([currentDevice(), endpointState(subscription.endpoint)]);
            const registered = !! device && (state === 'active' || state === null);
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
