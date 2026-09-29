import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const PROJECT_ROOT: string = resolve(import.meta.dirname, "..");
const OUTPUT_ROOT: string = resolve(PROJECT_ROOT, "dist", "sea-linux-x64");
const PAYLOAD_ROOT: string = join(OUTPUT_ROOT, "work", "payload");
const RELEASE_ROOT: string = join(OUTPUT_ROOT, "release");
const PACKAGE_ROOT: string = join(OUTPUT_ROOT, "work", "deb-root");
const INSTALL_ROOT: string = join(PACKAGE_ROOT, "usr", "lib", "daedalus-backend");
const CONTROL_PATH: string = join(PACKAGE_ROOT, "DEBIAN", "control");
const CHECKSUMS_PATH: string = join(RELEASE_ROOT, "SHA256SUMS.txt");

async function requireFile(path: string): Promise<void> {
    const info = await stat(path);
    if (!info.isFile()) {
        throw new Error(`Required backend payload file is missing: ${path}`);
    }
}

async function sha256File(path: string): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest("hex");
}

async function main(): Promise<void> {
    if (process.platform !== "linux" || process.arch !== "x64") {
        throw new Error("The Backend deb package must be built on Linux x64.");
    }

    const packageManifest = JSON.parse(await readFile(join(PROJECT_ROOT, "package.json"), "utf8")) as { version?: string };
    const version: string | undefined = packageManifest.version;
    if (version === undefined || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)) {
        throw new Error("package.json must contain a valid Backend version.");
    }
    const debVersion: string = version.replace("-", "~");
    const payloadManifest = JSON.parse(await readFile(join(PAYLOAD_ROOT, "backend-manifest.json"), "utf8")) as {
        version?: string;
        platform?: string;
        arch?: string;
    };
    if (payloadManifest.version !== version || payloadManifest.platform !== "linux" || payloadManifest.arch !== "x64") {
        throw new Error("The Linux SEA payload does not match the Backend version or architecture.");
    }
    for (const path of [
        join(PAYLOAD_ROOT, "daedalus-backend"),
        join(PAYLOAD_ROOT, "media", "node"),
        join(PAYLOAD_ROOT, "media", "image-worker.cjs"),
        join(PAYLOAD_ROOT, "media", "node_modules", "sharp", "package.json"),
    ]) {
        await requireFile(path);
    }

    await rm(PACKAGE_ROOT, { recursive: true, force: true });
    await mkdir(join(PACKAGE_ROOT, "DEBIAN"), { recursive: true });
    await mkdir(join(PACKAGE_ROOT, "usr", "bin"), { recursive: true });
    await cp(PAYLOAD_ROOT, INSTALL_ROOT, { recursive: true, dereference: true });
    await chmod(join(INSTALL_ROOT, "daedalus-backend"), 0o755);
    await chmod(join(INSTALL_ROOT, "media", "node"), 0o755);
    await writeFile(join(PACKAGE_ROOT, "usr", "bin", "daedalus-backend"), [
        "#!/bin/sh",
        "exec /usr/lib/daedalus-backend/daedalus-backend \"$@\"",
        "",
    ].join("\n"), { mode: 0o755 });
    await writeFile(CONTROL_PATH, [
        "Package: daedalus-backend",
        `Version: ${debVersion}`,
        "Architecture: amd64",
        "Maintainer: Daedalus <l_y_y_l@icloud.com>",
        "Section: utils",
        "Priority: optional",
        "Depends: libc6, libsecret-1-0, libstdc++6",
        "Recommends: bubblewrap",
        "Homepage: https://github.com/LuYingYiLong/daedalus-backend",
        "Description: Daedalus Backend runtime",
        " Standalone backend with its image processing runtime.",
        "",
    ].join("\n"), "utf8");

    const debPath: string = join(RELEASE_ROOT, `daedalus-backend_${debVersion}_amd64.deb`);
    await rm(debPath, { force: true });
    execFileSync("dpkg-deb", ["--root-owner-group", "--build", PACKAGE_ROOT, debPath], { stdio: "inherit" });
    await requireFile(debPath);

    const checksumLines: string[] = (await readFile(CHECKSUMS_PATH, "utf8"))
        .split(/\r?\n/u)
        .filter((line: string): boolean => line.length > 0 && !line.endsWith(`  ${basename(debPath)}`));
    checksumLines.push(`${await sha256File(debPath)}  ${basename(debPath)}`);
    await writeFile(CHECKSUMS_PATH, `${checksumLines.join("\n")}\n`, "utf8");
    process.stdout.write(`Built ${debPath}\n`);
}

main().catch((error: unknown): void => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
});
