export const SKILL_SOURCES = ["builtin", "personal", "project", "plugin"] as const;

export type SkillSource = typeof SKILL_SOURCES[number];
export type SkillRef = string;

export type ParsedSkillDocument = {
	name: string;
	description: string;
	body: string;
};

export type SkillSummary = {
	ref: SkillRef;
	slug: string;
	name: string;
	description: string;
	source: SkillSource;
	enabled: boolean;
	valid: boolean;
	editable: boolean;
	removable: boolean;
	displayPath: string;
	workspaceId?: string | undefined;
	sourceFolderId?: string | undefined;
	isPrimarySourceFolder?: boolean | undefined;
	error?: string | undefined;
};

export type CatalogSkill = SkillSummary & {
	filePath: string;
	document?: ParsedSkillDocument | undefined;
	defaultPromptId?: import("../protocol/types.js").PromptId | undefined;
	allowedTools?: string[] | undefined;
};

export type SkillWorkspace = {
	id: string;
	rootPath: string;
	sourceFolders?: Array<{
		id: string;
		rootPath: string;
	}> | undefined;
	primarySourceFolderId?: string | undefined;
};
