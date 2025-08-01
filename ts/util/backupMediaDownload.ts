// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { AttachmentDownloadManager } from '../jobs/AttachmentDownloadManager';
import { createLogger } from '../logging/log';
import { DataWriter } from '../sql/Client';

const log = createLogger('backupMediaDownload');

export async function startBackupMediaDownload(): Promise<void> {
  await window.storage.put('backupMediaDownloadPaused', false);

  await AttachmentDownloadManager.start();
}

export async function pauseBackupMediaDownload(): Promise<void> {
  log.info('Pausing media download');
  await window.storage.put('backupMediaDownloadPaused', true);
}

export async function resumeBackupMediaDownload(): Promise<void> {
  log.info('Resuming media download');
  return startBackupMediaDownload();
}

export async function resetBackupMediaDownloadItems(): Promise<void> {
  await Promise.all([
    window.storage.remove('backupMediaDownloadTotalBytes'),
    window.storage.remove('backupMediaDownloadCompletedBytes'),
    window.storage.remove('backupMediaDownloadBannerDismissed'),
    window.storage.remove('backupMediaDownloadPaused'),
  ]);
}

export async function cancelBackupMediaDownload(): Promise<void> {
  log.info('Canceling media download');
  await window.storage.put('backupMediaDownloadBannerDismissed', true);
  await DataWriter.removeAllBackupAttachmentDownloadJobs();
  await DataWriter.resetBackupAttachmentDownloadStats();
  await resetBackupMediaDownloadItems();
}

export async function resetBackupMediaDownloadProgress(): Promise<void> {
  await DataWriter.removeAllBackupAttachmentDownloadJobs();
  await DataWriter.resetBackupAttachmentDownloadStats();
  await resetBackupMediaDownloadItems();
}

export async function dismissBackupMediaDownloadBanner(): Promise<void> {
  await window.storage.put('backupMediaDownloadBannerDismissed', true);
}
