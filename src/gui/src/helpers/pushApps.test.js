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
import { appHoldsForPuter } from './pushApps.js';

const PUSH = 'notifications:push';
const listed = (...apps) => async () => apps;

describe('appHoldsForPuter', () => {
    it('counts push only for an app allowed for Puter`s devices', async () => {
        const holds = async () => true;
        await expect(appHoldsForPuter([PUSH], 'app-1', { holds, listApps: listed({ uid: 'app-1', puterDevices: false }) })).resolves.toBe(false);
        await expect(appHoldsForPuter([PUSH], 'app-1', { holds, listApps: listed({ uid: 'app-1', puterDevices: true }) })).resolves.toBe(true);
        // An older server lists no `puterDevices`, and a long list may leave the app out.
        await expect(appHoldsForPuter([PUSH], 'app-1', { holds, listApps: listed({ uid: 'app-1' }) })).resolves.toBe(true);
        await expect(appHoldsForPuter([PUSH], 'app-1', { holds, listApps: listed() })).resolves.toBe(true);
    });

    it('lists nothing when the grant is missing or push isn`t asked about', async () => {
        const listApps = vi.fn(listed());
        await expect(appHoldsForPuter([PUSH], 'app-1', { holds: async () => false, listApps })).resolves.toBe(false);
        await expect(appHoldsForPuter(['events:background'], 'app-1', { holds: async () => true, listApps })).resolves.toBe(true);
        expect(listApps).not.toHaveBeenCalled();
    });

    it('takes the grant alone where the server has no push routes, and rejects on other failures', async () => {
        const holds = async () => true;
        const fails = (code) => async () => {
            throw Object.assign(new Error('nope'), { code });
        };
        await expect(appHoldsForPuter([PUSH], 'app-1', { holds, listApps: fails('push_unavailable') })).resolves.toBe(true);
        await expect(appHoldsForPuter([PUSH], 'app-1', { holds, listApps: fails('internal_error') })).rejects.toThrow('nope');
    });
});
