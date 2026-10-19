import { Notice } from 'obsidian';

export class IndexerNotice {
	private notice: Notice;
	private status: HTMLDivElement;
	private progress: HTMLProgressElement;

	constructor() {
		const content = document.createDocumentFragment();
		const title = document.createElement('div');
		title.textContent = 'Vault helper — indexing vault…';

		this.status = document.createElement('div');
		this.progress = document.createElement('progress');
		this.progress.setAttribute('aria-label', 'Vault indexing progress');

		content.append(title, this.status, this.progress);
		this.update('Scanning vault…');
		this.notice = new Notice(content, 0);
	}

	update(message: string, completed?: number, total?: number): void {
		this.status.textContent = message;

		if (completed === undefined || total === undefined || total === 0) {
			this.progress.removeAttribute('value');
		} else {
			this.progress.max = total;
			this.progress.value = completed;
		}
	}

	hide(): void {
		this.notice.hide();
	}
}
