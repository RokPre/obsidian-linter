import {
	FileSystemAdapter,
	Editor,
	MarkdownView,
	MarkdownFileInfo,
	Modal,
	Notice,
	Plugin,
} from 'obsidian';
import { IndexerClient } from './indexer-client';
import { IndexerNotice } from './indexer-notice';
import {
	DEFAULT_SETTINGS,
	ObsidianLinterSettings,
	ObsidianLinterSettingTab,
} from './settings';

export default class ObsidianLinterPlugin extends Plugin {
	settings!: ObsidianLinterSettings;
	indexerClient!: IndexerClient;
	private indexerNotice?: IndexerNotice;

	async onload() {
		await this.loadSettings();
		const adapter = this.app.vault.adapter;
		if (adapter instanceof FileSystemAdapter) {
			const pluginDirectory = this.manifest.dir ??
				`${this.app.vault.configDir}/plugins/${this.manifest.id}`;
			const workerPath = adapter.getFullPath(`${pluginDirectory}/indexer-worker.cjs`);
			this.indexerClient = new IndexerClient(workerPath, {
				getFiles: () => this.app.vault.getFiles(),
				getFirstLinkpathDest: (linkpath, sourcePath) =>
					this.app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath),
			}, (progress) => {
				if (progress === null) {
					this.indexerNotice?.hide();
					this.indexerNotice = undefined;
					return;
				}
				this.indexerNotice ??= new IndexerNotice();
				if (progress.phase === 'indexing') {
					this.indexerNotice.update(
						`Indexing files: ${progress.completed} / ${progress.total}`,
						progress.completed,
						progress.total,
					);
				} else {
					this.indexerNotice.update(progress.phase === 'scanning'
						? 'Scanning vault…' : 'Updating tags and links…');
				}
			});
		}
		const indexCurrentVault = () => {
			const adapter = this.app.vault.adapter;
			if (!(adapter instanceof FileSystemAdapter)) return;
			return this.indexerClient.indexVault(adapter.getBasePath(), this.settings.ignoredPaths, this.app.vault.configDir).catch((error) => {
				console.error('Vault indexing failed', error);
			});
		};
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on('modify', indexCurrentVault));
			this.registerEvent(this.app.vault.on('delete', indexCurrentVault));
			this.registerEvent(this.app.vault.on('rename', indexCurrentVault));
			this.registerEvent(this.app.vault.on('create', indexCurrentVault));
			void indexCurrentVault();
		});

		// This creates an icon in the left ribbon.
		this.addRibbonIcon('dice', 'Sample', (_evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status bar text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-modal-simple',
			name: 'Open modal (simple)',
			callback: () => {
				new ObsidianLinterModal(this.app).open();
			},
		});
		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'replace-selected',
			name: 'Replace selected content',
			editorCallback: (
				editor: Editor,
				_ctx: MarkdownView | MarkdownFileInfo,
			) => {
				editor.replaceSelection('Sample editor command');
			},
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-modal-complex',
			name: 'Open modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						new ObsidianLinterModal(this.app).open();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
				return false;
			},
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new ObsidianLinterSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(activeDocument, 'click', (_evt: MouseEvent) => {
			new Notice('Click');
		});

	}

	onunload() {
		void this.indexerClient?.stop();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as Partial<ObsidianLinterSettings>,
		);
	}

	async saveSettings(settings: ObsidianLinterSettings = this.settings) {
		await this.saveData(settings);
	}
}

class ObsidianLinterModal extends Modal {
	onOpen() {
		const { contentEl } = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
