// Copyright 2017 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { clone, has } from 'lodash';
import { contextBridge } from 'electron';

import { createLogger } from '../../logging/log';

import '../context';

// Connect websocket early
import '../../textsecure/preconnect';

import './phase0-devtools';
import './phase1-ipc';
import '../preload';
import './phase2-dependencies';
import './phase3-post-signal';
import './phase4-test';
import '../../backbone/reliable_trigger';

import type {
  CdsLookupOptionsType,
  GetIceServersResultType,
} from '../../textsecure/WebAPI';
import type { FeatureFlagType } from '../../window.d';
import type { StorageAccessType } from '../../types/Storage.d';
import { start as startConversationController } from '../../ConversationController';
import { initMessageCleanup } from '../../services/messageStateCleanup';
import { Environment, getEnvironment } from '../../environment';
import { isProduction } from '../../util/version';
import { benchmarkConversationOpen } from '../../CI/benchmarkConversationOpen';

const log = createLogger('start');

window.addEventListener('contextmenu', e => {
  const node = e.target as Element | null;

  const isEditable = Boolean(
    node?.closest('textarea, input, [contenteditable="plaintext-only"]')
  );
  const isLink = Boolean(node?.closest('a'));
  const isImage = Boolean(node?.closest('.Lightbox img'));
  const hasSelection = Boolean(window.getSelection()?.toString());

  if (!isEditable && !hasSelection && !isLink && !isImage) {
    e.preventDefault();
  }
});

if (window.SignalContext.config.proxyUrl) {
  log.info('Using provided proxy url');
}

window.Whisper.events = clone(window.Backbone.Events);
initMessageCleanup();
startConversationController();

if (
  !isProduction(window.SignalContext.getVersion()) ||
  window.SignalContext.config.devTools
) {
  const SignalDebug = {
    cdsLookup: (options: CdsLookupOptionsType) =>
      window.textsecure.server?.cdsLookup(options),
    getSelectedConversation: () => {
      const conversationId =
        window.reduxStore.getState().conversations.selectedConversationId;
      return window.ConversationController.get(conversationId)?.attributes;
    },
    archiveSessionsForCurrentConversation: async () => {
      const conversationId =
        window.reduxStore.getState().conversations.selectedConversationId;
      await window.ConversationController.archiveSessionsForConversation(
        conversationId
      );
    },
    getConversation: (id: string) => window.ConversationController.get(id),
    getMessageById: (id: string) => window.MessageCache.getById(id)?.attributes,
    getMessageBySentAt: async (timestamp: number) => {
      const message = await window.MessageCache.findBySentAt(
        timestamp,
        () => true
      );
      return message?.attributes;
    },
    getReduxState: () => window.reduxStore.getState(),
    getSfuUrl: () => window.Signal.Services.calling._sfuUrl,
    getIceServerOverride: () =>
      window.Signal.Services.calling._iceServerOverride,
    getSocketStatus: () => window.textsecure.server?.getSocketStatus(),
    getStorageItem: (name: keyof StorageAccessType) => window.storage.get(name),
    putStorageItem: <K extends keyof StorageAccessType>(
      name: K,
      value: StorageAccessType[K]
    ) => window.storage.put(name, value),
    setFlag: (name: keyof FeatureFlagType, value: boolean) => {
      if (!has(window.Flags, name)) {
        return;
      }
      window.Flags[name] = value;
    },
    setSfuUrl: (url: string) => {
      window.Signal.Services.calling._sfuUrl = url;
    },
    setIceServerOverride: (
      override: GetIceServersResultType | string | undefined
    ) => {
      if (typeof override === 'string') {
        if (!/(turn|turns|stun):.*/.test(override)) {
          log.warn(
            'Override url should be prefixed with `turn:`, `turns:`, or `stun:` else override may not work'
          );
        }
      }

      window.Signal.Services.calling._iceServerOverride = override;
    },
    setRtcStatsInterval: (intervalMillis: number) =>
      window.Signal.Services.calling.setAllRtcStatsInterval(intervalMillis),
    ...(window.SignalContext.config.ciMode === 'benchmark'
      ? {
          benchmarkConversationOpen,
        }
      : {}),
  };

  contextBridge.exposeInMainWorld('SignalDebug', SignalDebug);
}

if (getEnvironment() === Environment.Test) {
  contextBridge.exposeInMainWorld('RETRY_DELAY', window.RETRY_DELAY);
  contextBridge.exposeInMainWorld('assert', window.assert);
  contextBridge.exposeInMainWorld('testUtilities', window.testUtilities);
}

// See ts/logging/log.ts
if (getEnvironment() !== Environment.PackagedApp) {
  const debug = (...args: Array<string>) => {
    localStorage.setItem('debug', args.join(','));
  };
  contextBridge.exposeInMainWorld('debug', debug);
}

if (window.SignalContext.config.ciMode === 'full') {
  contextBridge.exposeInMainWorld('SignalCI', window.SignalCI);
}

contextBridge.exposeInMainWorld('showDebugLog', window.IPC.showDebugLog);
contextBridge.exposeInMainWorld('startApp', window.startApp);
