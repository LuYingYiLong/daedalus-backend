import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDocumentXml, createMinimalDocx, findEndOfCentralDirectoryOffset } from "../../helpers/minimal-docx.js";
import { extractDocxParagraphs, extractParagraphsFromDocumentXml } from "../../../src/workspace/docx.js";
import { createWorkspaceFileService } from "../../../src/workspace/files.js";

test("DOCX paragraph extraction keeps entities, tabs, breaks and empty paragraphs", (): void => {
	const body: string = [
		"<w:r><w:t>Hello &amp; welcome &#x4e16;&#30028;</w:t></w:r>",
		"<w:r><w:t xml:space=\"preserve\">Line A</w:t><w:br/><w:t>Line B</w:t></w:r><w:r><w:tab/><w:t>Tabbed</w:t></w:r>",
		"<w:r><w:t>kept</w:t></w:r><w:del><w:r><w:delText>removed</w:delText></w:r></w:del>",
		"<w:r><w:instrText>PAGE</w:instrText><w:t>1</w:t></w:r>",
		""
	].map((paragraph: string): string => `<w:p>${paragraph}</w:p>`).join("");

	assert.deepEqual(extractParagraphsFromDocumentXml(createDocumentXml(body)), [
		"Hello & welcome 世界",
		"Line A\nLine B\tTabbed",
		"kept",
		"1",
		""
	]);
});

test("DOCX paragraph extraction keeps paragraph properties out of the text", (): void => {
	const xml: string = createDocumentXml("<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>Heading</w:t></w:r></w:p>");

	assert.deepEqual(extractParagraphsFromDocumentXml(xml), ["Heading"]);
});

test("DOCX archive extraction supports deflated and stored document parts", (): void => {
	const xml: string = createDocumentXml("<w:p><w:r><w:t>Compressed</w:t></w:r></w:p>");
	const withExtras: Buffer = createMinimalDocx(xml, {
		extraEntries: [
			{ name: "[Content_Types].xml", content: "<Types/>" },
			{ name: "word/styles.xml", content: "<styles/>" }
		]
	});

	assert.deepEqual(extractDocxParagraphs(createMinimalDocx(xml)), ["Compressed"]);
	assert.deepEqual(extractDocxParagraphs(createMinimalDocx(xml, { compressionMethod: 0 })), ["Compressed"]);
	assert.deepEqual(extractDocxParagraphs(withExtras), ["Compressed"]);
});

test("DOCX archive extraction rejects unsupported archives", (): void => {
	const documentXml: string = createDocumentXml("<w:p/>");

	assert.throws((): void => {
		extractDocxParagraphs(Buffer.from("not a docx", "utf8"));
	}, /not a \.docx/u);
	assert.throws((): void => {
		extractDocxParagraphs(Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), Buffer.alloc(64)]));
	}, /legacy binary \.doc/u);
	assert.throws((): void => {
		extractDocxParagraphs(createMinimalDocx(documentXml, { documentPartName: "word/other.xml" }));
	}, /no word\/document\.xml part/u);
	assert.throws((): void => {
		extractDocxParagraphs(createMinimalDocx(documentXml, { compressionMethod: 12 }));
	}, /compression method 12 is not supported/u);

	const multiDisk: Buffer = createMinimalDocx(documentXml);
	multiDisk.writeUInt16LE(1, findEndOfCentralDirectoryOffset(multiDisk) + 4);
	assert.throws((): void => {
		extractDocxParagraphs(multiDisk);
	}, /multi-disk/u);

	const zip64: Buffer = createMinimalDocx(documentXml);
	zip64.writeUInt16LE(0xffff, findEndOfCentralDirectoryOffset(zip64) + 10);
	assert.throws((): void => {
		extractDocxParagraphs(zip64);
	}, /ZIP64/u);
});

test("workspace readDocx validates paths, extension and paragraph ranges", async (): Promise<void> => {
	const root: string = await mkdtemp(join(tmpdir(), "daedalus-docx-read-"));
	try {
		const service = createWorkspaceFileService({ rootPath: root });
		const documentXml: string = createDocumentXml(
			"<w:p><w:r><w:t>First</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p><w:p><w:r><w:t>Third</w:t></w:r></w:p>"
		);
		await writeFile(join(root, "notes.docx"), createMinimalDocx(documentXml));
		await writeFile(join(root, "notes.txt"), "plain", "utf8");

		const full = await service.readDocx("notes.docx");
		assert.equal(full.path, "notes.docx");
		assert.equal(full.paragraphCount, 3);
		assert.equal(full.startParagraph, 1);
		assert.equal(full.endParagraph, 3);
		assert.equal(full.text, "First\nSecond\nThird");
		assert.equal(full.charCount, "First\nSecond\nThird".length);

		const ranged = await service.readDocx("notes.docx", { startParagraph: 2, endParagraph: 2 });
		assert.deepEqual([ranged.startParagraph, ranged.endParagraph, ranged.text], [2, 2, "Second"]);

		const beyondEnd = await service.readDocx("notes.docx", { startParagraph: 10 });
		assert.equal(beyondEnd.text, "");
		assert.equal(beyondEnd.paragraphCount, 3);

		await assert.rejects((): Promise<unknown> => service.readDocx("notes.txt"), /only supports \.docx/u);
		await assert.rejects((): Promise<unknown> => service.readDocx("../outside.docx"), /traversal|denied/u);
		await assert.rejects((): Promise<unknown> => service.readDocx("missing.docx"), /ENOENT/u);
		await assert.rejects((): Promise<unknown> => service.readDocx("notes.docx", { startParagraph: 0 }), /startParagraph/u);
		await assert.rejects((): Promise<unknown> => service.readDocx("notes.docx", { startParagraph: 3, endParagraph: 2 }), /endParagraph/u);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
