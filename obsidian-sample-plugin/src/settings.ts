import { AbstractInputSuggest, App, ButtonComponent, ExtraButtonComponent, FileSystemAdapter, Notice, PluginSettingTab, Setting } from 'obsidian';
import ObsidianLinterPlugin from './main';

export interface ObsidianLinterSettings {
	ignoredPaths: string[];
}

export const DEFAULT_SETTINGS: ObsidianLinterSettings = {
	ignoredPaths: [],
};

class IgnoredPathSuggest extends AbstractInputSuggest<string> {
	constructor(app: App, inputEl: HTMLInputElement, private isUsed: (path: string) => boolean) {
		super(app, inputEl);
	}

	getSuggestions(query: string): string[] {
		const search = query.toLowerCase();
		return this.app.vault.getAllLoadedFiles()
			.map((file) => file.path)
			.filter((path) =>
				path !== '/' && path.toLowerCase().includes(search) && !this.isUsed(path));
	}

	renderSuggestion(path: string, el: HTMLElement): void {
		el.setText(path);
	}

	selectSuggestion(path: string, evt: MouseEvent | KeyboardEvent): void {
		this.setValue(path);
		super.selectSuggestion(path, evt);
		this.close();
	}
}

export class ObsidianLinterSettingTab extends PluginSettingTab {
	plugin: ObsidianLinterPlugin;
	draftIgnoredPaths: string[] = [];

	constructor(app: App, plugin: ObsidianLinterPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	isDraftValid(): boolean {
		const paths = this.draftIgnoredPaths.filter((path) => path.trim() !== '');
		return paths.every((path, index) =>
			path !== '/' &&
			this.app.vault.getAbstractFileByPath(path) !== null &&
			paths.indexOf(path) === index);
	}

	display(): void {
		this.draftIgnoredPaths = [...this.plugin.settings.ignoredPaths];
		const { containerEl } = this;

		containerEl.empty();

		const ignoreListEl = containerEl.createDiv({ cls: 'vault-helper-ignore-list' });
		new Setting(ignoreListEl)
			.setName('Blacklist for files and folders')
			.setDesc('Exclude files or folders from indexing. Paths are relative to the vault root. Press Save to apply changes.');
		const pathPickersEl = ignoreListEl.createDiv();

		let addButton: ButtonComponent;
		const updateAddButton = () => {
			const hasEmptyPicker = this.draftIgnoredPaths.some((path) => path.trim() === '');
			addButton.setDisabled(hasEmptyPicker);
			if (hasEmptyPicker) addButton.removeCta();
			else addButton.setCta();
		};

		const canSave = () => {
			const draft = this.draftIgnoredPaths.filter((path) => path.trim() !== '');
			const saved = this.plugin.settings.ignoredPaths;
			const hasChanges = draft.length !== saved.length ||
				draft.some((path, index) => path !== saved[index]);

			return this.isDraftValid() && hasChanges;
		};

		let saveButton: ButtonComponent;
		const updateSaveButton = () => {
			const enabled = canSave();
			saveButton.setDisabled(!enabled);
			if (enabled) saveButton.setCta();
			else saveButton.removeCta();
		};

		const isOnlyBlankPicker = () =>
			this.draftIgnoredPaths.length === 1 &&
			this.draftIgnoredPaths[0]?.trim() === '';
		let clearButton: ButtonComponent;
		const updateClearButton = () => clearButton.setDisabled(isOnlyBlankPicker());

		const addPathPicker = (ignoredPath: string, index?: number) => {
			let removeButton: ExtraButtonComponent;
			new Setting(pathPickersEl)
				.setName('Ignored path')
				.setDesc('Exclude a file, or a folder and all its contents.')
				.addText((text) => {
					text.setPlaceholder('Choose file or folder');
					text.setValue(ignoredPath);
					if (index !== undefined) {
						text.onChange((value) => {
							this.draftIgnoredPaths[index] = value;
							updateAddButton();
							updateSaveButton();
							removeButton.setDisabled(isOnlyBlankPicker());
							updateClearButton();
						});
					}
					new IgnoredPathSuggest(this.app, text.inputEl, (path) =>
						this.draftIgnoredPaths.some((ignoredPath, otherIndex) =>
							otherIndex !== index && ignoredPath === path))
						.onSelect((value) => {
							if (index !== undefined) {
								this.draftIgnoredPaths[index] = value;
								updateAddButton();
								updateSaveButton();
								removeButton.setDisabled(isOnlyBlankPicker());
								updateClearButton();
							}
						});
				})
				.addExtraButton((button) => {
					removeButton = button;
					button
						.setIcon('x')
						.setTooltip('Remove from blacklist')
						.setDisabled(isOnlyBlankPicker())
						.onClick(() => {
							if (index === undefined || isOnlyBlankPicker()) return;
							this.draftIgnoredPaths.splice(index, 1);
							renderPathPickers();
							updateAddButton();
							updateSaveButton();
							updateClearButton();
						});
				});
		};

		const renderPathPickers = () => {
			if (this.draftIgnoredPaths.length === 0) this.draftIgnoredPaths.push('');
			pathPickersEl.empty();
			for (const [index, ignoredPath] of this.draftIgnoredPaths.entries()) {
				addPathPicker(ignoredPath, index);
			}
		};

		renderPathPickers();

		new Setting(ignoreListEl)
			.setClass('vault-helper-ignore-actions')
			.addButton((button) => {
				addButton = button;
				button
					.setButtonText('Add')
					.onClick(() => {
						this.draftIgnoredPaths.push('');
						addPathPicker('', this.draftIgnoredPaths.length - 1);
						updateAddButton();
						updateClearButton();
					});
				updateAddButton();
			})
			.addButton((button) => {
				clearButton = button;
				button
					.setButtonText('Clear')
					.setDisabled(isOnlyBlankPicker())
					.onClick(() => {
						this.draftIgnoredPaths = [''];
						renderPathPickers();
						updateAddButton();
						updateSaveButton();
						updateClearButton();
					});
			})
			.addButton((button) => {
				saveButton = button;
				button
					.setButtonText('Save')
					.onClick(async () => {
						if (!canSave()) return;

						const ignoredPaths = this.draftIgnoredPaths
							.filter((path) => path.trim() !== '');
						try {
							await this.plugin.saveSettings({ ...this.plugin.settings, ignoredPaths });
						} catch (error) {
							console.error('Settings save failed', error);
							new Notice(`Settings could not be saved: ${error instanceof Error ? error.message : String(error)}`);
							return;
						}
						this.plugin.settings.ignoredPaths = ignoredPaths;
						updateSaveButton();
						const adapter = this.app.vault.adapter;
						if (adapter instanceof FileSystemAdapter) {
							try {
								const result = await this.plugin.indexerClient.indexVault(adapter.getBasePath(), this.plugin.settings.ignoredPaths);
								new Notice(`Index updated: ${result.addedFiles} added, ${result.indexedFiles - result.addedFiles} updated, ${result.deletedFiles} removed.`);
							} catch (error) {
								console.error('Vault indexing failed', error);
								new Notice(`Settings saved, but indexing failed: ${error instanceof Error ? error.message : String(error)}`);
							}
						}
					});
				updateSaveButton();
			});

		new Setting(containerEl)
			.setName('Indexing')
			.setDesc('Scan the vault and update its index using the saved ignore list.')
			.addButton((button) =>
				button
					.setButtonText('Index vault')
					.onClick(async () => {
						const adapter = this.app.vault.adapter;
						if (!(adapter instanceof FileSystemAdapter)) {
							new Notice('Vault indexing requires Obsidian desktop.');
							return;
						}
						button.setDisabled(true);
						try {
							const result = await this.plugin.indexerClient.indexVault(adapter.getBasePath(), this.plugin.settings.ignoredPaths);
							new Notice(`Index updated: ${result.addedFiles} added, ${result.indexedFiles - result.addedFiles} updated, ${result.deletedFiles} removed.`);
						} catch (error) {
							console.error('Vault indexing failed', error);
							new Notice(`Indexing failed: ${error instanceof Error ? error.message : String(error)}`);
						} finally {
							button.setDisabled(false);
						}
					}),
			);

	}
}
