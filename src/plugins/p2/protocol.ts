import { z } from "zod";

export const PLUGIN_P2_API_VERSION = 1 as const;
export const PLUGIN_P2_CAPABILITIES = [
	"commands",
	"contextProviders",
	"panels",
	"settings",
	"timelineParts",
	"browser",
	"languageServices",
	"events"
] as const;
export type PluginP2Capability = (typeof PLUGIN_P2_CAPABILITIES)[number];

const pluginUiDescriptionsItemSchema = z.object({ label: z.string().min(1).max(160), value: z.string().max(4000) }).strict();
const pluginUiListItemSchema = z.object({ title: z.string().min(1).max(240), description: z.string().max(1000).optional() }).strict();
const pluginUiNodeSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("Text"), text: z.string().max(4000) }).strict(),
	z.object({ type: z.literal("Icon"), name: z.string().regex(/^[a-z0-9._-]{1,80}$/iu) }).strict(),
	z.object({ type: z.literal("Tag"), text: z.string().max(240), color: z.string().max(40).optional() }).strict(),
	z.object({ type: z.literal("Alert"), message: z.string().max(4000), typeValue: z.enum(["info", "success", "warning", "error"]).optional() }).strict(),
	z.object({ type: z.literal("Descriptions"), items: z.array(pluginUiDescriptionsItemSchema).max(32) }).strict(),
	z.object({ type: z.literal("Input"), id: z.string().regex(/^[a-z0-9._-]{1,80}$/iu), label: z.string().max(160).optional(), value: z.string().max(4000).optional(), placeholder: z.string().max(400).optional() }).strict(),
	z.object({ type: z.literal("Select"), id: z.string().regex(/^[a-z0-9._-]{1,80}$/iu), label: z.string().max(160).optional(), value: z.string().max(4000).optional(), options: z.array(z.object({ label: z.string().min(1).max(160), value: z.string().max(4000) }).strict()).max(64) }).strict(),
	z.object({ type: z.literal("Switch"), id: z.string().regex(/^[a-z0-9._-]{1,80}$/iu), label: z.string().max(160).optional(), checked: z.boolean().optional() }).strict(),
	z.object({ type: z.literal("Button"), id: z.string().regex(/^[a-z0-9._-]{1,80}$/iu), label: z.string().min(1).max(160), action: z.string().regex(/^[a-z0-9._:-]{1,160}$/iu).optional() }).strict(),
	z.object({ type: z.literal("List"), items: z.array(pluginUiListItemSchema).max(128) }).strict()
]);
const pluginUiViewSchema = z.array(pluginUiNodeSchema).max(128);

export const pluginP2CommandSchema = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu),
	command: z.string().regex(/^\/[a-z0-9][a-z0-9._-]{0,63}$/iu),
	description: z.string().min(1).max(1000),
	usage: z.string().max(300).optional(),
	handler: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/u),
	arguments: z.array(z.object({
		name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u),
		required: z.boolean(),
		description: z.string().max(500).optional()
	}).strict()).max(16).optional()
}).strict();

export const pluginP2ContextProviderSchema = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu),
	title: z.string().min(1).max(200),
	description: z.string().max(1000),
	scopes: z.array(z.enum(["workspace", "browser", "plugin"])).min(1).max(3),
	handler: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/u)
}).strict();

export const pluginP2PanelSchema = z.object({
	panelId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu),
	title: z.string().min(1).max(200),
	icon: z.string().max(80).optional(),
	locations: z.array(z.enum(["side", "bottom"])).min(1).max(2),
	stateSchema: z.record(z.string(), z.unknown()).optional(),
	view: pluginUiViewSchema,
	actions: z.record(z.string(), z.object({
		handler: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/u),
		risk: z.enum(["read", "verify", "propose", "write", "destructive"])
	}).strict()).optional()
}).strict();

export const pluginP2SettingsSchema = z.object({
	settingsId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu),
	title: z.string().min(1).max(200),
	icon: z.string().max(80).optional(),
	view: pluginUiViewSchema,
	stateSchema: z.record(z.string(), z.unknown()).optional(),
	handler: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/u).optional()
}).strict();

export const pluginP2TimelinePartSchema = z.object({
	partType: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu),
	title: z.string().max(200).optional(),
	icon: z.string().max(80).optional(),
	handler: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/u).optional()
}).strict();

export const pluginP2BrowserSchema = z.object({
	actions: z.array(z.enum(["navigate", "observe", "navigation", "scroll", "wait", "screenshot", "click", "type", "select", "download", "tabs"])).min(1).max(16),
	handler: z.string().regex(/^[a-zA-Z0-9._:-]{1,160}$/u)
}).strict();

export const pluginP2LanguageServiceSchema = z.object({
	id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/iu),
	languageIds: z.array(z.string().regex(/^[a-z0-9._+-]{1,80}$/iu)).min(1).max(16),
	extensions: z.array(z.string().regex(/^\.[a-z0-9._+-]{1,24}$/iu)).min(1).max(32),
	command: z.string().min(1).max(240),
	args: z.array(z.string().max(240)).max(32).optional(),
	capabilities: z.array(z.enum(["diagnostics", "hover", "completion", "definition", "references", "formatting", "rename"])).min(1).max(7)
}).strict();

export const pluginP2EventSchema = z.object({
	topic: z.string().regex(/^[a-z0-9][a-z0-9._/-]{0,127}$/iu),
	publish: z.boolean().optional(),
	subscribe: z.boolean().optional(),
	payloadSchema: z.record(z.string(), z.unknown()).optional()
}).strict().refine((value): boolean => value.publish === true || value.subscribe === true, "An event must publish or subscribe.");

export const pluginP2ManifestSchema = z.object({
	apiVersion: z.literal(PLUGIN_P2_API_VERSION),
	capabilities: z.object(Object.fromEntries(PLUGIN_P2_CAPABILITIES.map((key) => [key, z.number().int().positive().max(32).optional()])) as Record<PluginP2Capability, z.ZodOptional<z.ZodNumber>>).strict(),
	declarations: z.object({
		commands: z.array(pluginP2CommandSchema).max(128).optional(),
		contextProviders: z.array(pluginP2ContextProviderSchema).max(64).optional(),
		panels: z.array(pluginP2PanelSchema).max(32).optional(),
		settings: z.array(pluginP2SettingsSchema).max(32).optional(),
		timelineParts: z.array(pluginP2TimelinePartSchema).max(64).optional(),
		browser: pluginP2BrowserSchema.optional(),
		languageServices: z.array(pluginP2LanguageServiceSchema).max(32).optional(),
		events: z.array(pluginP2EventSchema).max(128).optional()
	}).strict()
}).strict();

export type PluginP2Manifest = z.infer<typeof pluginP2ManifestSchema>;
export type PluginCommandDefinition = z.infer<typeof pluginP2CommandSchema>;
export type PluginContextProviderDefinition = z.infer<typeof pluginP2ContextProviderSchema>;
export type PluginPanelDefinition = z.infer<typeof pluginP2PanelSchema>;
export type PluginSettingsDefinition = z.infer<typeof pluginP2SettingsSchema>;
export type PluginTimelinePartDefinition = z.infer<typeof pluginP2TimelinePartSchema>;
export type PluginBrowserDefinition = z.infer<typeof pluginP2BrowserSchema>;
export type PluginLanguageServiceDefinition = z.infer<typeof pluginP2LanguageServiceSchema>;
export type PluginEventDeclaration = z.infer<typeof pluginP2EventSchema>;

export type PluginP2DeclarationSummary = {
	apiVersion: number;
	compatible: boolean;
	unsupportedCapabilities: string[];
	commands: number;
	contextProviders: number;
	panels: number;
	settings: number;
	timelineParts: number;
	browser: boolean;
	languageServices: number;
	events: number;
	warnings: string[];
};

export function summarizePluginP2Manifest(manifest: PluginP2Manifest | undefined): PluginP2DeclarationSummary | undefined {
	if (manifest === undefined) return undefined;
	const supported = new Set<string>(PLUGIN_P2_CAPABILITIES);
	const unsupportedCapabilities = Object.keys(manifest.capabilities).filter((key): boolean => !supported.has(key));
	return {
		apiVersion: manifest.apiVersion,
		compatible: unsupportedCapabilities.length === 0,
		unsupportedCapabilities,
		commands: manifest.declarations.commands?.length ?? 0,
		contextProviders: manifest.declarations.contextProviders?.length ?? 0,
		panels: manifest.declarations.panels?.length ?? 0,
		settings: manifest.declarations.settings?.length ?? 0,
		timelineParts: manifest.declarations.timelineParts?.length ?? 0,
		browser: manifest.declarations.browser !== undefined,
		languageServices: manifest.declarations.languageServices?.length ?? 0,
		events: manifest.declarations.events?.length ?? 0,
		warnings: []
	};
}
