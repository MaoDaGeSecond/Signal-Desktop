// Copyright 2024 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
import { noop, omit, throttle } from 'lodash';
import { statfs } from 'node:fs/promises';

import * as durations from '../util/durations';
import { createLogger } from '../logging/log';
import type { AttachmentBackfillResponseSyncEvent } from '../textsecure/messageReceiverEvents';
import {
  type AttachmentDownloadJobTypeType,
  type AttachmentDownloadJobType,
  type CoreAttachmentDownloadJobType,
  AttachmentDownloadUrgency,
  coreAttachmentDownloadJobSchema,
} from '../types/AttachmentDownload';
import { downloadAttachment as downloadAttachmentUtil } from '../util/downloadAttachment';
import { DataReader, DataWriter } from '../sql/Client';
import { getValue } from '../RemoteConfig';

import { isInCall as isInCallSelector } from '../state/selectors/calling';
import {
  AttachmentSizeError,
  type AttachmentType,
  AttachmentVariant,
  AttachmentPermanentlyUndownloadableError,
  wasImportedFromLocalBackup,
  canAttachmentHaveThumbnail,
  shouldAttachmentEndUpInRemoteBackup,
  getUndownloadedAttachmentSignature,
} from '../types/Attachment';
import { type ReadonlyMessageAttributesType } from '../model-types.d';
import { getMessageById } from '../messages/getMessageById';
import {
  KIBIBYTE,
  getMaximumIncomingAttachmentSizeInKb,
  getMaximumIncomingTextAttachmentSizeInKb,
} from '../types/AttachmentSize';
import { addAttachmentToMessage } from '../messageModifiers/AttachmentDownloads';
import * as Errors from '../types/errors';
import { redactGenericText } from '../util/privacy';
import {
  JobManager,
  type JobManagerParamsType,
  type JobManagerJobResultType,
  type JobManagerJobType,
} from './JobManager';
import { IMAGE_JPEG } from '../types/MIME';
import { AttachmentDownloadSource } from '../sql/Interface';
import { drop } from '../util/drop';
import {
  getAttachmentCiphertextLength,
  type ReencryptedAttachmentV2,
} from '../AttachmentCrypto';
import { safeParsePartial } from '../util/schemas';
import { deleteDownloadsJobQueue } from './deleteDownloadsJobQueue';
import { createBatcher } from '../util/batcher';
import { showDownloadFailedToast } from '../util/showDownloadFailedToast';
import { markAttachmentAsPermanentlyErrored } from '../util/attachments/markAttachmentAsPermanentlyErrored';
import {
  AttachmentBackfill,
  isPermanentlyUndownloadable,
  isPermanentlyUndownloadableWithoutBackfill,
} from './helpers/attachmentBackfill';
import { formatCountForLogging } from '../logging/formatCountForLogging';
import { strictAssert } from '../util/assert';
import { updateBackupMediaDownloadProgress } from '../util/updateBackupMediaDownloadProgress';

const log = createLogger('AttachmentDownloadManager');

export { isPermanentlyUndownloadable };

// Type for adding a new job
export type NewAttachmentDownloadJobType = {
  attachment: AttachmentType;
  attachmentType: AttachmentDownloadJobTypeType;
  isManualDownload: boolean;
  messageId: string;
  receivedAt: number;
  sentAt: number;
  source: AttachmentDownloadSource;
  urgency?: AttachmentDownloadUrgency;
};

const MAX_CONCURRENT_JOBS = 3;

const DEFAULT_RETRY_CONFIG = {
  maxAttempts: 5,
  backoffConfig: {
    // 30 seconds, 5 minutes, 50 minutes, (max) 6 hrs
    multiplier: 10,
    firstBackoffs: [30 * durations.SECOND],
    maxBackoffTime: 6 * durations.HOUR,
  },
};
const BACKUP_RETRY_CONFIG = {
  ...DEFAULT_RETRY_CONFIG,
  maxAttempts: Infinity,
};

type RunDownloadAttachmentJobOptions = {
  abortSignal: AbortSignal;
  isForCurrentlyVisibleMessage: boolean;
  maxAttachmentSizeInKib: number;
  maxTextAttachmentSizeInKib: number;
};

type AttachmentDownloadManagerParamsType = Omit<
  JobManagerParamsType<CoreAttachmentDownloadJobType>,
  'getNextJobs' | 'runJob'
> & {
  getNextJobs: (options: {
    limit: number;
    prioritizeMessageIds?: Array<string>;
    sources?: Array<AttachmentDownloadSource>;
    timestamp?: number;
  }) => Promise<Array<AttachmentDownloadJobType>>;
  runDownloadAttachmentJob: (args: {
    job: AttachmentDownloadJobType;
    isLastAttempt: boolean;
    options: RunDownloadAttachmentJobOptions;
    dependencies?: DependenciesType;
  }) => Promise<JobManagerJobResultType<CoreAttachmentDownloadJobType>>;
  onLowDiskSpaceBackupImport: (bytesNeeded: number) => Promise<void>;
  statfs: typeof statfs;
};

function getJobId(job: CoreAttachmentDownloadJobType): string {
  const { messageId, attachmentType, attachmentSignature } = job;
  return `${messageId}.${attachmentType}.${attachmentSignature}`;
}

function getJobIdForLogging(job: CoreAttachmentDownloadJobType): string {
  const { sentAt, attachmentType, attachmentSignature } = job;
  const redactedAttachmentSignature = redactGenericText(attachmentSignature);
  return `${sentAt}.${attachmentType}.${redactedAttachmentSignature}`;
}

export class AttachmentDownloadManager extends JobManager<CoreAttachmentDownloadJobType> {
  #visibleTimelineMessages: Set<string> = new Set();

  #saveJobsBatcher = createBatcher<AttachmentDownloadJobType>({
    name: 'saveAttachmentDownloadJobs',
    wait: 150,
    maxSize: 1000,
    processBatch: async jobs => {
      await DataWriter.saveAttachmentDownloadJobs(jobs);
      drop(this.maybeStartJobs());
    },
  });
  #onLowDiskSpaceBackupImport: (bytesNeeded: number) => Promise<void>;
  #statfs: typeof statfs;
  #maxAttachmentSizeInKib = getMaximumIncomingAttachmentSizeInKb(getValue);
  #maxTextAttachmentSizeInKib =
    getMaximumIncomingTextAttachmentSizeInKb(getValue);

  #minimumFreeDiskSpace = this.#maxAttachmentSizeInKib * 5;

  #attachmentBackfill = new AttachmentBackfill();

  private static _instance: AttachmentDownloadManager | undefined;
  override logPrefix = 'AttachmentDownloadManager';

  static defaultParams: AttachmentDownloadManagerParamsType = {
    markAllJobsInactive: DataWriter.resetAttachmentDownloadActive,
    saveJob: async (job, options) => {
      if (options?.allowBatching) {
        if (AttachmentDownloadManager._instance != null) {
          AttachmentDownloadManager._instance.#saveJobsBatcher.add(job);
        }
      } else {
        await DataWriter.saveAttachmentDownloadJob(job);
      }
    },
    removeJob: DataWriter.removeAttachmentDownloadJob,
    getNextJobs: DataWriter.getNextAttachmentDownloadJobs,
    runDownloadAttachmentJob,
    shouldHoldOffOnStartingQueuedJobs: () => {
      const reduxState = window.reduxStore?.getState();
      if (reduxState) {
        return isInCallSelector(reduxState);
      }
      return false;
    },
    getJobId,
    getJobIdForLogging,
    getRetryConfig: job =>
      shouldAttachmentEndUpInRemoteBackup({
        attachment: job.attachment,
        hasMediaBackups: window.Signal.Services.backups.hasMediaBackups(),
      })
        ? BACKUP_RETRY_CONFIG
        : DEFAULT_RETRY_CONFIG,
    maxConcurrentJobs: MAX_CONCURRENT_JOBS,
    onLowDiskSpaceBackupImport: async bytesNeeded => {
      if (!window.storage.get('backupMediaDownloadPaused')) {
        await Promise.all([
          window.storage.put('backupMediaDownloadPaused', true),
          // Show the banner to allow users to resume from the left pane
          window.storage.put('backupMediaDownloadBannerDismissed', false),
        ]);
      }
      window.reduxActions.globalModals.showLowDiskSpaceBackupImportModal(
        bytesNeeded
      );
    },
    statfs,
  };

  constructor(params: AttachmentDownloadManagerParamsType) {
    super({
      ...params,
      getNextJobs: ({ limit }) => {
        return params.getNextJobs({
          limit,
          prioritizeMessageIds: [...this.#visibleTimelineMessages],
          sources: window.storage.get('backupMediaDownloadPaused')
            ? [AttachmentDownloadSource.STANDARD]
            : undefined,
          timestamp: Date.now(),
        });
      },
      runJob: async (
        job: AttachmentDownloadJobType,
        {
          abortSignal,
          isLastAttempt,
        }: { abortSignal: AbortSignal; isLastAttempt: boolean }
      ) => {
        const isForCurrentlyVisibleMessage = this.#visibleTimelineMessages.has(
          job.messageId
        );

        if (job.source === AttachmentDownloadSource.BACKUP_IMPORT) {
          const { outOfSpace } =
            await this.#checkFreeDiskSpaceForBackupImport();
          if (outOfSpace) {
            return { status: 'retry' };
          }
        }

        return params.runDownloadAttachmentJob({
          job,
          isLastAttempt,
          options: {
            abortSignal,
            isForCurrentlyVisibleMessage,
            maxAttachmentSizeInKib: this.#maxAttachmentSizeInKib,
            maxTextAttachmentSizeInKib: this.#maxTextAttachmentSizeInKib,
          },
        });
      },
    });
    this.#onLowDiskSpaceBackupImport = params.onLowDiskSpaceBackupImport;
    this.#statfs = params.statfs;
  }

  // @ts-expect-error we are overriding the return type of JobManager's addJob
  override async addJob(
    newJobData: NewAttachmentDownloadJobType
  ): Promise<AttachmentType> {
    const {
      attachment,
      attachmentType,
      isManualDownload,
      messageId,
      receivedAt,
      sentAt,
      source,
      urgency = AttachmentDownloadUrgency.STANDARD,
    } = newJobData;

    const logId = `AttachmentDownloadManager/addJob(${sentAt}.${attachmentType})`;

    if (attachment.error && source === AttachmentDownloadSource.BACKUP_IMPORT) {
      return attachment;
    }

    const parseResult = safeParsePartial(coreAttachmentDownloadJobSchema, {
      attachment,
      attachmentType,
      ciphertextSize: getAttachmentCiphertextLength(attachment.size),
      contentType: attachment.contentType,
      attachmentSignature: getUndownloadedAttachmentSignature(attachment),
      isManualDownload,
      messageId,
      receivedAt,
      sentAt,
      size: attachment.size,
      source,
      originalSource: source,
    });

    if (!parseResult.success) {
      log.error(`${logId}: invalid data`, parseResult.error);
      return attachment;
    }

    const newJob = parseResult.data;

    await this._addJob(newJob, {
      forceStart: urgency === AttachmentDownloadUrgency.IMMEDIATE,
    });

    return attachment;
  }

  updateVisibleTimelineMessages(messageIds: Array<string>): void {
    this.#visibleTimelineMessages = new Set(messageIds);
  }

  async #getFreeDiskSpace(): Promise<number> {
    const { bsize, bavail } = await this.#statfs(
      window.SignalContext.getPath('userData')
    );
    return bsize * bavail;
  }

  async #checkFreeDiskSpaceForBackupImport(): Promise<{
    outOfSpace: boolean;
  }> {
    let freeDiskSpace: number;

    try {
      freeDiskSpace = await this.#getFreeDiskSpace();
    } catch (e) {
      log.error(
        'checkFreeDiskSpaceForBackupImport: error checking disk space',
        Errors.toLogFormat(e)
      );
      // Still attempt the download
      return { outOfSpace: false };
    }

    if (freeDiskSpace <= this.#minimumFreeDiskSpace) {
      const remainingBackupBytesToDownload =
        window.storage.get('backupMediaDownloadTotalBytes', 0) -
        window.storage.get('backupMediaDownloadCompletedBytes', 0);

      log.info(
        'checkFreeDiskSpaceForBackupImport: insufficient disk space. ' +
          `Available: ${formatCountForLogging(freeDiskSpace)}, ` +
          `Needed: ${formatCountForLogging(remainingBackupBytesToDownload)} ` +
          `Minimum threshold: ${this.#minimumFreeDiskSpace}`
      );

      await this.#onLowDiskSpaceBackupImport(remainingBackupBytesToDownload);
      return { outOfSpace: true };
    }

    return { outOfSpace: false };
  }

  static get instance(): AttachmentDownloadManager {
    if (!AttachmentDownloadManager._instance) {
      AttachmentDownloadManager._instance = new AttachmentDownloadManager(
        AttachmentDownloadManager.defaultParams
      );
    }
    return AttachmentDownloadManager._instance;
  }

  static async start(): Promise<void> {
    await AttachmentDownloadManager.saveBatchedJobs();
    await window.storage.put('attachmentDownloadManagerIdled', false);
    await AttachmentDownloadManager.instance.start();
    drop(
      AttachmentDownloadManager.waitForIdle(async () => {
        await updateBackupMediaDownloadProgress(
          DataReader.getBackupAttachmentDownloadProgress
        );
        await window.storage.put('attachmentDownloadManagerIdled', true);
      })
    );
  }

  static async saveBatchedJobs(): Promise<void> {
    await AttachmentDownloadManager.instance.#saveJobsBatcher.flushAndWait();
  }

  static async stop(): Promise<void> {
    return AttachmentDownloadManager._instance?.stop();
  }

  static async addJob(
    newJob: NewAttachmentDownloadJobType
  ): Promise<AttachmentType> {
    return AttachmentDownloadManager.instance.addJob(newJob);
  }

  static async cancelJobs(
    predicate: (
      job: CoreAttachmentDownloadJobType & JobManagerJobType
    ) => boolean
  ): Promise<void> {
    return AttachmentDownloadManager.instance.cancelJobs(predicate);
  }

  static updateVisibleTimelineMessages(messageIds: Array<string>): void {
    AttachmentDownloadManager.instance.updateVisibleTimelineMessages(
      messageIds
    );
  }

  static async waitForIdle(callback?: VoidFunction): Promise<void> {
    await AttachmentDownloadManager.instance.waitForIdle();
    if (callback) {
      callback();
    }
  }

  static async requestBackfill(
    message: ReadonlyMessageAttributesType
  ): Promise<void> {
    return this.instance.#attachmentBackfill.request(message);
  }

  static async handleBackfillResponse(
    event: AttachmentBackfillResponseSyncEvent
  ): Promise<void> {
    return this.instance.#attachmentBackfill.handleResponse(event);
  }
}

type DependenciesType = {
  deleteDownloadData: typeof window.Signal.Migrations.deleteDownloadData;
  downloadAttachment: typeof downloadAttachmentUtil;
  processNewAttachment: typeof window.Signal.Migrations.processNewAttachment;
};
async function runDownloadAttachmentJob({
  job,
  isLastAttempt,
  options,
  dependencies = {
    deleteDownloadData: window.Signal.Migrations.deleteDownloadData,
    downloadAttachment: downloadAttachmentUtil,
    processNewAttachment: window.Signal.Migrations.processNewAttachment,
  },
}: {
  job: AttachmentDownloadJobType;
  isLastAttempt: boolean;
  options: RunDownloadAttachmentJobOptions;
  dependencies?: DependenciesType;
}): Promise<JobManagerJobResultType<CoreAttachmentDownloadJobType>> {
  const jobIdForLogging = getJobIdForLogging(job);
  const logId = `AttachmentDownloadManager/runDownloadAttachmentJob/${jobIdForLogging}`;

  const message = await getMessageById(job.messageId);

  if (!message) {
    log.error(`${logId} message not found`);
    return { status: 'finished' };
  }

  try {
    log.info(`${logId}: Starting job`);

    const result = await runDownloadAttachmentJobInner({
      job,
      abortSignal: options.abortSignal,
      isForCurrentlyVisibleMessage:
        options?.isForCurrentlyVisibleMessage ?? false,
      maxAttachmentSizeInKib: options.maxAttachmentSizeInKib,
      maxTextAttachmentSizeInKib: options.maxTextAttachmentSizeInKib,
      dependencies,
    });

    if (result.downloadedVariant === AttachmentVariant.ThumbnailFromBackup) {
      return {
        status: 'finished',
        newJob: { ...job, attachment: result.attachmentWithThumbnail },
      };
    }

    return {
      status: 'finished',
    };
  } catch (error) {
    if (options.abortSignal.aborted) {
      log.warn(
        `${logId}: Cancelled attempt ${job.attempts}. Not scheduling a retry. Error:`,
        Errors.toLogFormat(error)
      );
      // Remove `pending` flag from the attachment. User can retry later.
      await addAttachmentToMessage(
        message.id,
        {
          ...job.attachment,
          pending: false,
        },
        logId,
        { type: job.attachmentType }
      );
      return { status: 'finished' };
    }

    log.error(
      `${logId}: Failed to download attachment, attempt ${job.attempts}:`,
      Errors.toLogFormat(error)
    );

    if (error instanceof AttachmentSizeError) {
      await addAttachmentToMessage(
        message.id,
        _markAttachmentAsTooBig(job.attachment),
        logId,
        { type: job.attachmentType }
      );
      return { status: 'finished' };
    }

    if (error instanceof AttachmentPermanentlyUndownloadableError) {
      const canBackfill =
        job.isManualDownload &&
        AttachmentBackfill.isEnabledForJob(
          job.attachmentType,
          message.attributes
        );

      if (job.source !== AttachmentDownloadSource.BACKFILL && canBackfill) {
        await AttachmentDownloadManager.requestBackfill(message.attributes);
        return { status: 'finished' };
      }

      await addAttachmentToMessage(
        message.id,
        markAttachmentAsPermanentlyErrored(job.attachment, {
          backfillError: false,
        }),
        logId,
        { type: job.attachmentType }
      );

      return { status: 'finished' };
    }

    if (isLastAttempt) {
      await addAttachmentToMessage(
        message.id,
        _markAttachmentAsTransientlyErrored(job.attachment),
        logId,
        { type: job.attachmentType }
      );
      return { status: 'finished' };
    }

    // Remove `pending` flag from the attachment and retry later
    await addAttachmentToMessage(
      message.id,
      {
        ...job.attachment,
        pending: false,
      },
      logId,
      { type: job.attachmentType }
    );
    return { status: 'retry' };
  } finally {
    // This will fail if the message has been deleted before the download finished, which
    // is good
    await window.MessageCache.saveMessage(message.attributes);
  }
}

type DownloadAttachmentResultType =
  | { downloadedVariant: AttachmentVariant.Default }
  | {
      downloadedVariant: AttachmentVariant.ThumbnailFromBackup;
      attachmentWithThumbnail: AttachmentType;
    };

export async function runDownloadAttachmentJobInner({
  job,
  abortSignal,
  isForCurrentlyVisibleMessage,
  maxAttachmentSizeInKib,
  maxTextAttachmentSizeInKib,
  dependencies,
}: {
  job: AttachmentDownloadJobType;
  dependencies: DependenciesType;
} & RunDownloadAttachmentJobOptions): Promise<DownloadAttachmentResultType> {
  const { messageId, attachment, attachmentType } = job;

  const jobIdForLogging = getJobIdForLogging(job);
  let logId = `AttachmentDownloadManager/runDownloadJobInner(${jobIdForLogging})`;

  if (!job || !attachment || !messageId) {
    throw new Error(`${logId}: Key information required for job was missing.`);
  }

  const { size } = attachment;
  const sizeInKib = size / KIBIBYTE;

  if (
    !Number.isFinite(size) ||
    size < 0 ||
    sizeInKib > maxAttachmentSizeInKib
  ) {
    throw new AttachmentSizeError(
      `${logId}: Attachment was ${sizeInKib}kib, max is ${maxAttachmentSizeInKib}kib`
    );
  }
  if (
    attachmentType === 'long-message' &&
    sizeInKib > maxTextAttachmentSizeInKib
  ) {
    throw new AttachmentSizeError(
      `${logId}: Text attachment was ${sizeInKib}kib, max is ${maxTextAttachmentSizeInKib}kib`
    );
  }
  const hasMediaBackups = window.Signal.Services.backups.hasMediaBackups();
  const mightBeInRemoteBackup = shouldAttachmentEndUpInRemoteBackup({
    attachment,
    hasMediaBackups,
  });
  const wasAttachmentImportedFromLocalBackup =
    wasImportedFromLocalBackup(attachment);
  const alreadyDownloadedBackupThumbnail = Boolean(
    job.attachment.thumbnailFromBackup
  );

  const mightHaveBackupThumbnailToDownload =
    !alreadyDownloadedBackupThumbnail &&
    mightBeInRemoteBackup &&
    canAttachmentHaveThumbnail(attachment) &&
    !wasAttachmentImportedFromLocalBackup;

  const preferBackupThumbnail =
    isForCurrentlyVisibleMessage && mightHaveBackupThumbnailToDownload;

  if (preferBackupThumbnail) {
    logId += '.preferringBackupThumbnail';
  }

  if (preferBackupThumbnail) {
    try {
      const attachmentWithThumbnail = await downloadBackupThumbnail({
        attachment,
        abortSignal,
        dependencies,
      });
      await addAttachmentToMessage(messageId, attachmentWithThumbnail, logId, {
        type: attachmentType,
      });
      return {
        downloadedVariant: AttachmentVariant.ThumbnailFromBackup,
        attachmentWithThumbnail,
      };
    } catch (e) {
      log.warn(
        `${logId}: error when trying to download thumbnail`,
        Errors.toLogFormat(e)
      );
    }
  }

  // TODO (DESKTOP-7204): currently we only set pending state when downloading the
  // full-size attachment
  await addAttachmentToMessage(
    messageId,
    { ...attachment, pending: true },
    logId,
    { type: attachmentType }
  );

  if (
    job.source !== AttachmentDownloadSource.BACKFILL &&
    isPermanentlyUndownloadableWithoutBackfill(job.attachment)
  ) {
    // We should only get to here only if
    throw new AttachmentPermanentlyUndownloadableError(
      'Not downloadable without backfill'
    );
  }

  try {
    const { downloadPath } = attachment;
    let totalDownloaded = 0;
    let downloadedAttachment: ReencryptedAttachmentV2 | undefined;

    const onSizeUpdate = async (totalBytes: number) => {
      if (abortSignal.aborted) {
        return;
      }
      if (downloadedAttachment) {
        return;
      }

      totalDownloaded = Math.min(totalBytes, attachment.size);
      await addAttachmentToMessage(
        messageId,
        { ...attachment, totalDownloaded, pending: true },
        logId,
        { type: attachmentType }
      );
    };

    downloadedAttachment = await dependencies.downloadAttachment({
      attachment,
      options: {
        variant: AttachmentVariant.Default,
        onSizeUpdate: throttle(onSizeUpdate, 200),
        abortSignal,
        hasMediaBackups,
      },
    });

    const upgradedAttachment = await dependencies.processNewAttachment({
      ...omit(attachment, ['error', 'pending']),
      ...downloadedAttachment,
    });

    const isShowingLightbox = (): boolean => {
      const lightboxState = window.reduxStore.getState().lightbox;
      if (!lightboxState.isShowingLightbox) {
        return false;
      }
      if (lightboxState.selectedIndex == null) {
        return false;
      }

      const selectedMedia = lightboxState.media[lightboxState.selectedIndex];
      if (selectedMedia?.message.id !== messageId) {
        return false;
      }

      return selectedMedia.attachment.digest === attachment.digest;
    };

    const shouldDeleteDownload = downloadPath && !isShowingLightbox();
    if (downloadPath) {
      if (shouldDeleteDownload) {
        await dependencies.deleteDownloadData(downloadPath);
      } else {
        deleteDownloadsJobQueue.pause();
        await deleteDownloadsJobQueue.add({
          digest: attachment.digest,
          downloadPath,
          messageId,
          plaintextHash: attachment.plaintextHash,
        });
      }
    }

    await addAttachmentToMessage(
      messageId,
      shouldDeleteDownload
        ? omit(upgradedAttachment, ['downloadPath', 'totalDownloaded'])
        : omit(upgradedAttachment, ['totalDownloaded']),
      logId,
      {
        type: attachmentType,
      }
    );
    return { downloadedVariant: AttachmentVariant.Default };
  } catch (error) {
    if (mightHaveBackupThumbnailToDownload && !preferBackupThumbnail) {
      log.error(
        `${logId}: failed to download fullsize attachment, falling back to backup thumbnail`,
        Errors.toLogFormat(error)
      );
      try {
        const attachmentWithThumbnail = omit(
          await downloadBackupThumbnail({
            attachment,
            abortSignal,
            dependencies,
          }),
          'pending'
        );
        await addAttachmentToMessage(
          messageId,
          attachmentWithThumbnail,
          logId,
          {
            type: attachmentType,
          }
        );
        return {
          downloadedVariant: AttachmentVariant.ThumbnailFromBackup,
          attachmentWithThumbnail,
        };
      } catch (thumbnailError) {
        log.error(
          `${logId}: fallback attempt to download thumbnail failed`,
          Errors.toLogFormat(thumbnailError)
        );
      }
    }

    let showToast = false;

    // Show toast if manual download failed
    if (!abortSignal.aborted && job.isManualDownload) {
      if (job.source === AttachmentDownloadSource.BACKFILL) {
        // ...and it was already a backfill request
        showToast = true;
      } else {
        // ...or we didn't backfill the download
        const message = await getMessageById(job.messageId);
        showToast =
          message != null &&
          !AttachmentBackfill.isEnabledForJob(
            attachmentType,
            message.attributes
          );
      }
    }

    if (showToast) {
      showDownloadFailedToast(messageId);
    }

    throw error;
  }
}

async function downloadBackupThumbnail({
  attachment,
  abortSignal,
  dependencies,
}: {
  attachment: AttachmentType;
  abortSignal: AbortSignal;
  dependencies: {
    downloadAttachment: typeof downloadAttachmentUtil;
  };
}): Promise<AttachmentType> {
  const downloadedThumbnail = await dependencies.downloadAttachment({
    attachment,
    options: {
      onSizeUpdate: noop,
      variant: AttachmentVariant.ThumbnailFromBackup,
      abortSignal,
      hasMediaBackups: true,
    },
  });

  const calculatedSize = downloadedThumbnail.size;
  strictAssert(calculatedSize, 'size must be calculated for backup thumbnails');

  const attachmentWithThumbnail = {
    ...attachment,
    thumbnailFromBackup: {
      contentType: IMAGE_JPEG,
      ...downloadedThumbnail,
      size: calculatedSize,
    },
  };

  return attachmentWithThumbnail;
}

function _markAttachmentAsTooBig(attachment: AttachmentType): AttachmentType {
  return {
    ...markAttachmentAsPermanentlyErrored(attachment, {
      backfillError: false,
    }),
    wasTooBig: true,
  };
}

function _markAttachmentAsTransientlyErrored(
  attachment: AttachmentType
): AttachmentType {
  return { ...attachment, pending: false, error: true };
}
