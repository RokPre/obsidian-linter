export const IGNORED_DIRECTORY_NAMES: Record<string, true> = {
	'.git': true,
	templates: true,
	excalidraws: true,
	'.diaryTrash': true,
};

export function isIgnoredVaultPath(
	vaultPath: string,
	ignoredPaths: string[],
	configDir: string,
	isDirectory = false,
): boolean {
	const normalizedConfigDir = configDir.replaceAll('\\', '/').replace(/\/{2,}/g, '/');
	if (
		ignoredPaths.some((ignoredPath) => vaultPath === ignoredPath || vaultPath.startsWith(`${ignoredPath}/`)) ||
		vaultPath === normalizedConfigDir ||
		vaultPath.startsWith(`${normalizedConfigDir}/`)
	) {
		return true;
	}

	const pathParts = vaultPath.split('/');
	const directoryParts = isDirectory ? pathParts : pathParts.slice(0, -1);
	return directoryParts.some((part) => IGNORED_DIRECTORY_NAMES[part] === true);
}
