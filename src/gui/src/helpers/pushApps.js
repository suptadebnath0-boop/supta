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

import { appHoldsPermissions } from './holdsPermissions.js';
import { listPushApps, PUSH_UNAVAILABLE } from './notificationApi.js';
import { PUSH_PERMISSION } from './pushClient.js';

/** An app a website's Web Push confirmation let in pushes only to that website's browsers, not to Puter's. @param {import('./notificationApi.js').PushApp|undefined} app */
export const pushesToPuter = (app) => app?.puterDevices !== false;

/**
 * Whether the app holds every one of `permissions`, counting
 * `notifications:push` only when its pushes may go to Puter's devices.
 * Rejects when the list of push apps can't be read.
 *
 * @param {string[]} permissions
 * @param {string} appUid
 * @param {{ holds?: (permissions: string[], appUid: string) => Promise<boolean>, listApps?: () => Promise<import('./notificationApi.js').PushApp[]> }} [deps]
 * @returns {Promise<boolean>}
 */
export const appHoldsForPuter = async (permissions, appUid, {
    holds = appHoldsPermissions,
    listApps = listPushApps,
} = {}) => {
    if ( ! await holds(permissions, appUid) ) return false;
    if ( ! permissions.includes(PUSH_PERMISSION) ) return true;
    let apps;
    try {
        apps = await listApps();
    } catch ( e ) {
        // Without the push routes no grant can be a website's own.
        if ( e?.code === PUSH_UNAVAILABLE ) return true;
        throw e;
    }
    return pushesToPuter(apps.find((app) => app.uid === appUid));
};

/** `appHoldsForPuter` for `notifications:push` alone, `false` when it can't tell. @param {string} appUid @returns {Promise<boolean>} */
export const appPushesToPuter = (appUid) => appHoldsForPuter([PUSH_PERMISSION], appUid).catch((e) => {
    console.warn('[push] could not tell whether an app may push to Puter', e);
    return false;
});
