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

// https://github.com/kerl/kerl/blob/2.0.0/kerl#L595
async function maybePatch(otpVersion: string): Promise<void> {
  const [major, minor, ...rest] = otpVersion
    .replace(/^OTP-/, "")
    .split(".")
    .map((string) => parseInt(string, 10));
  if (platform() === "darwin") {
    await maybePatchDarwin(major, minor, rest);
    await maybePatchCatalina(major, minor, rest);
  }

  await maybePatchAll(major, minor, rest);
}

// https://github.com/kerl/kerl/blob/2.0.0/kerl#L647
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function maybePatchDarwin(major: number, minor: number, rest: number[]): Promise<void> {
  if (17 <= major && major <= 19) {
    await applyWxPtrPatch();
  }
}

// https://github.com/kerl/kerl/blob/2.0.0/kerl#L1913
async function applyWxPtrPatch(): Promise<void> {
  const patch = `
diff --git a/lib/wx/c_src/wxe_impl.cpp b/lib/wx/c_src/wxe_impl.cpp
index 0d2da5d4a79..8118136d30e 100644
--- a/lib/wx/c_src/wxe_impl.cpp
+++ b/lib/wx/c_src/wxe_impl.cpp
@@ -666,7 +666,7 @@ void * WxeApp::getPtr(char * bp, wxeMemEnv *memenv) {
     throw wxe_badarg(index);
   }
   void * temp = memenv->ref2ptr[index];
-  if((index < memenv->next) && ((index == 0) || (temp > NULL)))
+  if((index < memenv->next) && ((index == 0) || (temp != (void *)NULL)))
     return temp;
   else {
     throw wxe_badarg(index);
@@ -678,7 +678,7 @@ void WxeApp::registerPid(char * bp, ErlDrvTermData pid, wxeMemEnv * memenv) {
   if(!memenv)
     throw wxe_badarg(index);
   void * temp = memenv->ref2ptr[index];
-  if((index < memenv->next) && ((index == 0) || (temp > NULL))) {
+  if((index < memenv->next) && ((index == 0) || (temp != (void *) NULL))) {
     ptrMap::iterator it;
     it = ptr2ref.find(temp);
     if(it != ptr2ref.end()) {
`;
  await exec("patch", ["-p1", "--quiet"], { input: Buffer.from(patch) });
}

// https://github.com/kerl/kerl/blob/2.0.0/kerl#L660
async function maybePatchCatalina(major: number, minor: number, rest: number[]): Promise<void> {
  if ((19 < major && major < 23) || (major == 19 && 1 < minor) || (major == 22 && minor == 3 && (rest[0] || 0) < 1)) {
    await applyCatarinaNoWeakImportsPatch();
  }
}

// https://github.com/kerl/kerl/blob/2.0.0/kerl#L694
async function applyCatarinaNoWeakImportsPatch(): Promise<void> {
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

// https://github.com/kerl/kerl/blob/2.0.0/kerl#L616
// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function maybePatchAll(major: number, minor: number, rest: number[]): Promise<void> {
  if (17 <= major && major <= 19) {
    await applyZlibPatch();
  }
}

async function applyZlibPatch(): Promise<void> {
  const patch = `
diff --git a/erts/emulator/beam/external.c b/erts/emulator/beam/external.c
index 656de7c49ad..4491d486837 100644
--- a/erts/emulator/beam/external.c
+++ b/erts/emulator/beam/external.c
@@ -1193,6 +1193,7 @@ typedef struct B2TContext_t {
     } u;
 } B2TContext;

+static B2TContext* b2t_export_context(Process*, B2TContext* src);

 static uLongf binary2term_uncomp_size(byte* data, Sint size)
 {
@@ -1225,7 +1226,7 @@ static uLongf binary2term_uncomp_size(byte* data, Sint size)

 static ERTS_INLINE int
 binary2term_prepare(ErtsBinary2TermState *state, byte *data, Sint data_size,
-		    B2TContext* ctx)
+		    B2TContext** ctxp, Process* p)
 {
     byte *bytes = data;
     Sint size = data_size;
@@ -1239,8 +1240,8 @@ binary2term_prepare(ErtsBinary2TermState *state, byte *data, Sint data_size,
     size--;
     if (size < 5 || *bytes != COMPRESSED) {
 	state->extp = bytes;
-        if (ctx)
-	    ctx->state = B2TSizeInit;
+        if (ctxp)
+	    (*ctxp)->state = B2TSizeInit;
     }
     else  {
 	uLongf dest_len = (Uint32) get_int32(bytes+1);
@@ -1257,16 +1258,26 @@ binary2term_prepare(ErtsBinary2TermState *state, byte *data, Sint data_size,
                 return -1;
 	    }
 	    state->extp = erts_alloc(ERTS_ALC_T_EXT_TERM_DATA, dest_len);
-            ctx->reds -= dest_len;
+            if (ctxp)
+                (*ctxp)->reds -= dest_len;
 	}
 	state->exttmp = 1;
-        if (ctx) {
+        if (ctxp) {
+            /*
+             * Start decompression by exporting trap context
+             * so we don't have to deal with deep-copying z_stream.
+             */
+            B2TContext* ctx = b2t_export_context(p, *ctxp);
+            ASSERT(state = &(*ctxp)->b2ts);
+            state = &ctx->b2ts;
+
 	    if (erl_zlib_inflate_start(&ctx->u.uc.stream, bytes, size) != Z_OK)
 		return -1;

 	    ctx->u.uc.dbytes = state->extp;
 	    ctx->u.uc.dleft = dest_len;
 	    ctx->state = B2TUncompressChunk;
+            *ctxp = ctx;
         }
 	else {
 	    uLongf dlen = dest_len;
@@ -1308,7 +1319,7 @@ erts_binary2term_prepare(ErtsBinary2TermState *state, byte *data, Sint data_size
 {
     Sint res;

-    if (binary2term_prepare(state, data, data_size, NULL) < 0 ||
+    if (binary2term_prepare(state, data, data_size, NULL, NULL) < 0 ||
         (res=decoded_size(state->extp, state->extp + state->extsize, 0, NULL)) < 0) {

         if (state->exttmp)
@@ -1435,7 +1446,7 @@ static Eterm binary_to_term_int(Process* p, Uint32 flags, Eterm bin, Binary* con
             if (ctx->aligned_alloc) {
                 ctx->reds -= bin_size / 8;
             }
-            if (binary2term_prepare(&ctx->b2ts, bytes, bin_size, ctx) < 0) {
+            if (binary2term_prepare(&ctx->b2ts, bytes, bin_size, &ctx, p) < 0) {
 		ctx->state = B2TBadArg;
 	    }
             break;
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
  await maybePatch(otpVersion);
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
