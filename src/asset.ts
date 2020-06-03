import { group } from "@actions/core";
import { exec } from "@actions/exec";
import { GitHub } from "@actions/github";
import { createReadStream, readdirSync, statSync, writeFileSync } from "fs";
import { cpus, platform } from "os";
import * as path from "path";
import { chdir, cwd } from "process";

async function getRelease(
  octokit: GitHub,
  owner: string,
  repo: string,
  tag: string
): Promise<[number, string] | undefined> {
  return octokit.repos
    .getReleaseByTag({
      owner,
      repo,
      tag,
    })
    .then(({ data: { id, upload_url } }) => [id, upload_url] as [number, string])
    .catch((e) => {
      if (e?.status !== 404) {
        throw new Error(`Unexpected error occured: ${JSON.stringify(e)}`);
      }
      return undefined;
    });
}

async function createRelease(octokit: GitHub, owner: string, repo: string, tag: string): Promise<[number, string]> {
  const {
    data: { id, upload_url },
  } = await octokit.repos.createRelease({ owner, repo, tag_name: tag });
  return [id, upload_url];
}

async function maybeApplyPatch(otpVersion: string): Promise<void> {
  const [major, minor, ...rest] = otpVersion
    .replace(/^OTP-/, "")
    .split(".")
    .map((string) => parseInt(string, 10));
  // The patch will be applied unless:
  // - the platform isn't darwin
  // - the OTP major version is equal or greater than 23
  // - the OTP version is equal or greater than 22.3.1
  if (platform() !== "darwin" || 23 <= major || (major === 22 && minor === 3 && 1 <= rest[0])) {
    return;
  }
  const patch = `
diff --git a/erts/configure.in b/erts/configure.in
index 3ba8216a19..d7cebc5ebc 100644
--- a/erts/configure.in
+++ b/erts/configure.in
@@ -926,20 +926,16 @@ dnl for now that is the way we do it.
 USER_LD=$LD
 USER_LDFLAGS="$LDFLAGS"
 LD='$(CC)'
+
 case $host_os in
-     darwin*)
-	saved_LDFLAGS="$LDFLAGS"
-	LDFLAGS="$LDFLAGS -Wl,-no_weak_imports"
-	AC_TRY_LINK([],[],
-		[
-			LD_MAY_BE_WEAK=no
-		],
-		[
-			LD_MAY_BE_WEAK=yes
-			LDFLAGS="$saved_LDFLAGS"
-		]);;
-    *)
-	LD_MAY_BE_WEAK=no;;
+        darwin19*)
+	    # Disable stack checking to avoid crashing with a segment fault
+	    # in macOS Catalina.
+	    AC_MSG_NOTICE([Turning off stack check on macOS 10.15 (Catalina)])
+	    CFLAGS="-fno-stack-check $CFLAGS"
+	    ;;
+        *)
+	    ;;
 esac
 AC_SUBST(LD)
`;
  await exec("patch", ["-p1", "--quiet"], { input: Buffer.from(patch) });
}

async function make(): Promise<void> {
  const cpuCount = cpus().length;
  let sslOption: string;
  if (platform() === "darwin") {
    let opensslPath = "";
    await exec("brew", ["--prefix", "openssl"], {
      listeners: {
        stdout: (data: Buffer): void => {
          opensslPath += data.toString();
        },
      },
    });
    sslOption = `--with-ssl=${opensslPath.trim()}`;
  } else {
    sslOption = "--with-ssl";
  }
  await group("otp_build", async () => await exec("./otp_build", ["autoconf"]));
  await group("configure", async () => await exec("./configure", [sslOption, "--enable-dirty-schedulers"]));
  await group("make", async () => await exec("make", [`-j${cpuCount}`]));
  await group("make release", async () => await exec("make", ["release"]));
}

async function archive(assetName: string): Promise<string> {
  const currentWorkingDirectory = cwd();
  const releaseDirectory = path.join(currentWorkingDirectory, "release");
  const subDirectories = readdirSync(releaseDirectory, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
  if (subDirectories.length < 1) {
    throw new Error(`Expect a sub directory in ${releaseDirectory} exists, but it doesn't.`);
  } else if (1 < subDirectories.length) {
    throw new Error(
      `Expect a sub directory in ${releaseDirectory} exists, but it has too many directories named ${subDirectories.join(
        ","
      )}.`
    );
  }
  const subDirectory = path.join(releaseDirectory, subDirectories[0]);
  const archivedPath = path.join(releaseDirectory, assetName);

  // To compress files in the release directory easily, enter the directory
  chdir(subDirectory);
  await exec("tar", ["-zcf", archivedPath, "."]);
  chdir(currentWorkingDirectory);
  return archivedPath;
}

async function sha256(archivedPath: string): Promise<string> {
  const { dir, base } = path.parse(archivedPath);
  const sha256FileName = path.basename(base, ".tar.gz") + ".sha256.txt";
  const sha256FilePath = path.join(dir, sha256FileName);
  let buffer = "";
  await exec("shasum", ["-a", "256", archivedPath], {
    listeners: {
      stdline: (data: string): string => (buffer += data),
    },
  });
  const sha256 = buffer.split(" ", 1)[0];
  writeFileSync(sha256FilePath, sha256);
  return sha256FilePath;
}

async function uploadAsset(octokit: GitHub, url: string, name: string, assetPath: string): Promise<void> {
  const headers = {
    "content-type": "application/octet-stream",
    "content-length": statSync(assetPath).size,
  };
  const data = createReadStream(assetPath);
  await octokit.repos.uploadReleaseAsset({
    headers,
    url,
    data,
    name,
  });
}

export async function getOrCreateRelease(
  octokit: GitHub,
  owner: string,
  repo: string,
  tag: string
): Promise<[number, string]> {
  return (await getRelease(octokit, owner, repo, tag)) || (await createRelease(octokit, owner, repo, tag));
}

export async function getAsset(
  octokit: GitHub,
  owner: string,
  repo: string,
  releaseId: number,
  assetName: string
): Promise<number | undefined> {
  const { data: assets } = await octokit.repos.listAssetsForRelease({
    owner,
    repo,
    release_id: releaseId,
  });
  const result = assets.find((asset) => asset.name === assetName);
  return result?.id;
}

export async function makeAsset(otpVersion: string, assetName: string): Promise<[string, string]> {
  await maybeApplyPatch(otpVersion);
  await make();
  const archivedPath = await archive(assetName);
  const sha256Path = await sha256(archivedPath);
  return [archivedPath, sha256Path];
}

export async function uploadAssets(octokit: GitHub, uploadUrl: string, assetPaths: string[]): Promise<void> {
  await Promise.all(
    assetPaths.map((assetPath) => {
      const assetName = path.basename(assetPath);
      uploadAsset(octokit, uploadUrl, assetName, assetPath);
    })
  );
}
