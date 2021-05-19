/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from 'vs/nls';
import { Disposable, dispose, IDisposable } from 'vs/base/common/lifecycle';
import { ResourceMap } from 'vs/base/common/map';
import { Promises } from 'vs/base/common/async';
import { IFileService } from 'vs/platform/files/common/files';
import { URI } from 'vs/base/common/uri';
import { ILogService } from 'vs/platform/log/common/log';
import { IWorkingCopyBackupService } from 'vs/workbench/services/workingCopy/common/workingCopyBackup';
import { IBaseFileWorkingCopy, IBaseFileWorkingCopyModel } from 'vs/workbench/services/workingCopy/common/abstractFileWorkingCopy';
import { FileWorkingCopy, IFileWorkingCopy, IFileWorkingCopyModel } from 'vs/workbench/services/workingCopy/common/fileWorkingCopy';
import { IFileWorkingCopyResolver } from 'vs/workbench/services/workingCopy/common/fileWorkingCopyManager';
import { UntitledFileWorkingCopy } from 'vs/workbench/services/workingCopy/common/untitledFileWorkingCopy';
import { IConfirmation, IDialogService, IFileDialogService } from 'vs/platform/dialogs/common/dialogs';
import { basename, dirname, isEqual, joinPath, toLocalResource } from 'vs/base/common/resources';
import { IUriIdentityService } from 'vs/workbench/services/uriIdentity/common/uriIdentity';
import { CancellationToken } from 'vs/base/common/cancellation';
import { IWorkingCopyFileService } from 'vs/workbench/services/workingCopy/common/workingCopyFileService';
import { VSBufferReadableStream } from 'vs/base/common/buffer';
import { IWorkingCopyService } from 'vs/workbench/services/workingCopy/common/workingCopyService';
import { IWorkbenchEnvironmentService } from 'vs/workbench/services/environment/common/environmentService';
import { IPathService } from 'vs/workbench/services/path/common/pathService';
import { isValidBasename } from 'vs/base/common/extpath';
import { ISaveOptions } from 'vs/workbench/common/editor';

export interface IBaseFileWorkingCopyManager<M extends IBaseFileWorkingCopyModel, W extends IBaseFileWorkingCopy<M>> extends IDisposable {

	/**
	 * Access to all known file working copies within the manager.
	 */
	readonly workingCopies: readonly W[];

	/**
	 * Returns the file working copy for the provided resource
	 * or `undefined` if none.
	 */
	get(resource: URI): W | undefined;

	/**
	 * Implements "Save As" for file based working copies. The API is `URI` based
	 * because it works even without resolved file working copies. If a file working
	 * copy exists for any given `URI`, the implementation will deal with them properly
	 * (e.g. dirty contents of the source will be written to the target and the source
	 * will be reverted).
	 *
	 * Note: it is possible that the returned file working copy has a different `URI`
	 * than the `target` that was passed in. Based on URI identity, the file working
	 * copy may chose to return an existing file working copy with different casing
	 * to respect file systems that are case insensitive.
	 *
	 * Note: Callers must `dispose` the working copy when no longer needed.
	 *
	 * @param source the source resource to save as
	 * @param target the optional target resource to save to. if not defined, the user
	 * will be asked for input
	 * @returns the target working copy that was saved to or `undefined` in case of
	 * cancellation
	 */
	saveAs(source: URI, target: URI, options?: ISaveOptions): Promise<IFileWorkingCopy<IFileWorkingCopyModel> | undefined>;
	saveAs(source: URI, target: undefined, options?: IBaseFileWorkingCopySaveAsOptions): Promise<IFileWorkingCopy<IFileWorkingCopyModel> | undefined>;

	/**
	 * Disposes all working copies of the manager and disposes the manager. This
	 * method is different from `dispose` in that it will unregister any working
	 * copy from the `IWorkingCopyService`. Since this impact things like backups,
	 * the method is `async` because it needs to trigger `save` for any dirty
	 * working copy to preserve the data.
	 *
	 * Callers should make sure to e.g. close any editors associated with the
	 * working copy.
	 */
	destroy(): Promise<void>;
}

export interface IBaseFileWorkingCopySaveAsOptions extends ISaveOptions {

	/**
	 * Optional target resource to suggest to the user in case
	 * no taget resource is provided to save to.
	 */
	suggestedTarget?: URI;
}

export abstract class BaseFileWorkingCopyManager<M extends IBaseFileWorkingCopyModel, W extends IBaseFileWorkingCopy<M>> extends Disposable implements IBaseFileWorkingCopyManager<M, W> {

	private readonly mapResourceToWorkingCopy = new ResourceMap<W>();
	private readonly mapResourceToDisposeListener = new ResourceMap<IDisposable>();

	constructor(
		protected readonly workingCopyTypeId: string,
		private readonly fileWorkingCopyResolver: IFileWorkingCopyResolver,
		@IFileService protected readonly fileService: IFileService,
		@ILogService protected readonly logService: ILogService,
		@IWorkingCopyBackupService private readonly workingCopyBackupService: IWorkingCopyBackupService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IUriIdentityService protected readonly uriIdentityService: IUriIdentityService,
		@IWorkingCopyFileService protected readonly workingCopyFileService: IWorkingCopyFileService,
		@IDialogService private readonly dialogService: IDialogService,
		@IWorkingCopyService private readonly workingCopyService: IWorkingCopyService,
		@IWorkbenchEnvironmentService private readonly environmentService: IWorkbenchEnvironmentService,
		@IPathService private readonly pathService: IPathService
	) {
		super();
	}

	protected has(resource: URI): boolean {
		return this.mapResourceToWorkingCopy.has(resource);
	}

	protected add(resource: URI, workingCopy: W): void {
		const knownWorkingCopy = this.get(resource);
		if (knownWorkingCopy === workingCopy) {
			return; // already cached
		}

		// Add to our working copy map
		this.mapResourceToWorkingCopy.set(resource, workingCopy);

		// Update our dipsose listener to remove it on dispose
		this.mapResourceToDisposeListener.get(resource)?.dispose();
		this.mapResourceToDisposeListener.set(resource, workingCopy.onWillDispose(() => this.remove(resource)));
	}

	protected remove(resource: URI): void {

		// Dispose any existing listener
		const disposeListener = this.mapResourceToDisposeListener.get(resource);
		if (disposeListener) {
			dispose(disposeListener);
			this.mapResourceToDisposeListener.delete(resource);
		}

		// Remove from our working copy map
		this.mapResourceToWorkingCopy.delete(resource);
	}

	//#region Get / Get all

	get workingCopies(): W[] {
		return [...this.mapResourceToWorkingCopy.values()];
	}

	get(resource: URI): W | undefined {
		return this.mapResourceToWorkingCopy.get(resource);
	}

	private getFile(resource: URI): IFileWorkingCopy<IFileWorkingCopyModel> | undefined {
		const workingCopy = this.workingCopyService.get({ resource, typeId: this.workingCopyTypeId });
		if (workingCopy instanceof FileWorkingCopy) {
			return workingCopy;
		}

		return undefined;
	}

	//#endregion

	//#region Save

	async saveAs(source: URI, target?: URI, options?: IBaseFileWorkingCopySaveAsOptions): Promise<IFileWorkingCopy<IFileWorkingCopyModel> | undefined> {

		// Get to target resource
		if (!target) {
			const workingCopy = this.get(source);
			if (workingCopy instanceof UntitledFileWorkingCopy && workingCopy.hasAssociatedFilePath) {
				target = await this.suggestSavePath(source);
			} else {
				target = await this.fileDialogService.pickFileToSave(await this.suggestSavePath(options?.suggestedTarget ?? source), options?.availableFileSystems);
			}
		}

		if (!target) {
			return; // user canceled
		}

		// Just save if target is same as working copies own resource
		// and we are not saving an untitled file working copy
		if (this.fileService.canHandleResource(source) && isEqual(source, target)) {
			return this.doSave(source, { ...options, force: true  /* force to save, even if not dirty (https://github.com/microsoft/vscode/issues/99619) */ });
		}

		// If the target is different but of same identity, we
		// move the source to the target, knowing that the
		// underlying file system cannot have both and then save.
		// However, this will only work if the source exists
		// and is not orphaned, so we need to check that too.
		if (this.fileService.canHandleResource(source) && this.uriIdentityService.extUri.isEqual(source, target) && (await this.fileService.exists(source))) {

			// Move via working copy file service to enable participants
			await this.workingCopyFileService.move([{ file: { source, target } }], CancellationToken.None);

			// At this point we don't know whether we have a
			// working copy for the source or the target URI so we
			// simply try to save with both resources.
			return (await this.doSave(source, options)) ?? (await this.doSave(target, options));
		}

		// Perform normal "Save As"
		return this.doSaveAs(source, target, options);
	}

	private async doSave(resource: URI, options?: ISaveOptions): Promise<IFileWorkingCopy<IFileWorkingCopyModel> | undefined> {

		// Save is only possible with file working copies,
		// any other have to go via `saveAs` flow.
		const fileWorkingCopy = this.getFile(resource);
		if (fileWorkingCopy) {
			const success = await fileWorkingCopy.save(options);
			if (success) {
				return fileWorkingCopy;
			}
		}

		return undefined;
	}

	private async doSaveAs(source: URI, target: URI, options?: IBaseFileWorkingCopySaveAsOptions): Promise<IFileWorkingCopy<IFileWorkingCopyModel> | undefined> {
		let sourceContents: VSBufferReadableStream;

		// If the source is an existing file working copy, we can directly
		// use that to copy the contents to the target destination
		const sourceWorkingCopy = this.get(source);
		if (sourceWorkingCopy?.isResolved()) {
			sourceContents = await sourceWorkingCopy.model.snapshot(CancellationToken.None);
		}

		// Otherwise we resolve the contents from the underlying file
		else {
			sourceContents = (await this.fileService.readFileStream(source)).value;
		}

		// Resolve target
		const { targetFileExists, targetFileWorkingCopy } = await this.doResolveSaveTarget(source, target);

		// Confirm to overwrite if we have an untitled file working copy with associated path where
		// the file actually exists on disk and we are instructed to save to that file path.
		// This can happen if the file was created after the untitled file was opened.
		// See https://github.com/microsoft/vscode/issues/67946
		if (
			sourceWorkingCopy instanceof UntitledFileWorkingCopy &&
			sourceWorkingCopy.hasAssociatedFilePath &&
			targetFileExists &&
			this.uriIdentityService.extUri.isEqual(target, toLocalResource(sourceWorkingCopy.resource, this.environmentService.remoteAuthority, this.pathService.defaultUriScheme))
		) {
			const overwrite = await this.confirmOverwrite(target);
			if (!overwrite) {
				return undefined;
			}
		}

		// Take over content from source to target
		await targetFileWorkingCopy.model?.update(sourceContents, CancellationToken.None);

		// Save target
		await targetFileWorkingCopy.save({ ...options, force: true  /* force to save, even if not dirty (https://github.com/microsoft/vscode/issues/99619) */ });

		// Revert the source
		await sourceWorkingCopy?.revert();

		return targetFileWorkingCopy;
	}

	private async doResolveSaveTarget(source: URI, target: URI): Promise<{ targetFileExists: boolean, targetFileWorkingCopy: IFileWorkingCopy<IFileWorkingCopyModel> }> {

		// Prefer an existing file working copy if it is already resolved
		// for the given target resource
		let targetFileExists = false;
		let targetFileWorkingCopy = this.getFile(target);
		if (targetFileWorkingCopy?.isResolved()) {
			targetFileExists = true;
		}

		// Otherwise create the target working copy empty if
		// it does not exist already and resolve it from there
		else {
			targetFileExists = await this.fileService.exists(target);

			// Create target file adhoc if it does not exist yet
			if (!targetFileExists) {
				await this.workingCopyFileService.create([{ resource: target }], CancellationToken.None);
			}

			// At this point we need to resolve the target working copy
			// and we have to do an explicit check if the source URI
			// equals the target via URI identity. If they match and we
			// have had an existing working copy with the source, we
			// prefer that one over resolving the target. Otherwise we
			// would potentially introduce a
			if (this.uriIdentityService.extUri.isEqual(source, target) && this.has(source)) {
				targetFileWorkingCopy = await this.fileWorkingCopyResolver(source);
			} else {
				targetFileWorkingCopy = await this.fileWorkingCopyResolver(target);
			}
		}

		return { targetFileExists, targetFileWorkingCopy };
	}

	private async confirmOverwrite(resource: URI): Promise<boolean> {
		const confirm: IConfirmation = {
			message: localize('confirmOverwrite', "'{0}' already exists. Do you want to replace it?", basename(resource)),
			detail: localize('irreversible', "A file or folder with the name '{0}' already exists in the folder '{1}'. Replacing it will overwrite its current contents.", basename(resource), basename(dirname(resource))),
			primaryButton: localize({ key: 'replaceButtonLabel', comment: ['&& denotes a mnemonic'] }, "&&Replace"),
			type: 'warning'
		};

		const result = await this.dialogService.confirm(confirm);
		return result.confirmed;
	}

	private async suggestSavePath(resource: URI): Promise<URI> {

		// 1.) Just take the resource as is if the file service can handle it
		if (this.fileService.canHandleResource(resource)) {
			return resource;
		}

		// 2.) Pick the associated file path for untitled working copies if any
		const workingCopy = this.get(resource);
		if (workingCopy instanceof UntitledFileWorkingCopy && workingCopy.hasAssociatedFilePath) {
			return toLocalResource(resource, this.environmentService.remoteAuthority, this.pathService.defaultUriScheme);
		}

		// 3.) Pick the working copy name if valid joined with default path
		if (workingCopy && isValidBasename(workingCopy.name)) {
			return joinPath(await this.fileDialogService.defaultFilePath(), workingCopy.name);
		}

		// 4.) Finally fallback to the name of the resource joined with default path
		return joinPath(await this.fileDialogService.defaultFilePath(), basename(resource));
	}

	//#endregion

	//#region Lifecycle

	override dispose(): void {
		super.dispose();

		// Clear working copy caches
		//
		// Note: we are not explicitly disposing the working copies
		// known to the manager because this can have unwanted side
		// effects such as backups getting discarded once the working
		// copy unregisters. We have an explicit `destroy`
		// for that purpose (https://github.com/microsoft/vscode/pull/123555)
		//
		this.mapResourceToWorkingCopy.clear();

		// Dispose the dispose listeners
		dispose(this.mapResourceToDisposeListener.values());
		this.mapResourceToDisposeListener.clear();
	}

	async destroy(): Promise<void> {

		// Make sure all dirty working copies are saved to disk
		try {
			await Promises.settled(this.workingCopies.map(async workingCopy => {
				if (workingCopy.isDirty()) {
					await this.saveWithFallback(workingCopy);
				}
			}));
		} catch (error) {
			this.logService.error(error);
		}

		// Dispose all working copies
		dispose(this.mapResourceToWorkingCopy.values());

		// Finally dispose manager
		this.dispose();
	}

	private async saveWithFallback(workingCopy: W): Promise<void> {

		// First try regular save
		let saveFailed = false;
		try {
			await workingCopy.save();
		} catch (error) {
			saveFailed = true;
		}

		// Then fallback to backup if that exists
		if (saveFailed || workingCopy.isDirty()) {
			const backup = await this.workingCopyBackupService.resolve(workingCopy);
			if (backup) {
				await this.fileService.writeFile(workingCopy.resource, backup.value, { unlock: true });
			}
		}
	}

	//#endregion
}