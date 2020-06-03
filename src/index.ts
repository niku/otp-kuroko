import { getOrCreateRelease, getAsset, makeAsset, uploadAssets } from "./asset";
import { error, getInput, setFailed, info } from "@actions/core";
import { exec } from "@actions/exec";
import { GitHub } from "@actions/github";
import { env } from "process";

async function getAssetName(): Promise<string> {
  let buffer = "";
  await exec("uname", ["-s", "-r"], {
    listeners: {
      stdline: (data: string): string => (buffer += data),
    },
  });
  return buffer.trim().toLowerCase().replace(" ", "-").concat(".tar.gz");
}

async function getOTPVersions(pattern: string): Promise<string[]> {
  const buffer = [] as string[];
  await exec("git", ["tag", "--list", pattern], {
    listeners: {
      stdline: (data: string): void => {
        buffer.push(data);
      },
    },
  });
  return buffer;
}

async function setup(otpVersion: string): Promise<void> {
  await exec("git", ["reset", "--hard", "--quiet"]);
  await exec("git", ["checkout", "--quiet", otpVersion]);
  await exec("git", ["clean", "-dfqx"]); // https://git-scm.com/docs/git-clean
}

async function run(): Promise<void> {
  try {
    const secretToken = getInput("secret-token");
    const octokit = new GitHub(secretToken);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const [owner, repo] = (env.GITHUB_REPOSITORY! as string).split("/");
    const assetName = await getAssetName();
    const targetPattern = getInput("target-pattern") || "OTP-*";
    const otpVersions = await getOTPVersions(targetPattern);
    // We consider that it doesn't need to care about API rate limiting. The limit is 5000 requests per hour [1].
    // If the asset has been already exists, it consumes 2 API (getOrCreateRelease, getAsset).
    // Currently, target versions are less than 300. So, at most it consumes 600(2 * 300) requests only.
    // [1] https://developer.github.com/v3/#rate-limiting
    for await (const otpVersion of otpVersions) {
      info(`Starting ${otpVersion}.`);
      try {
        await setup(otpVersion);
        const [releaseId, uploadUrl] = await getOrCreateRelease(octokit, owner, repo, otpVersion);
        const assetId = await getAsset(octokit, owner, repo, releaseId, assetName);
        if (!assetId) {
          const [archivedPath, sha256Path] = await makeAsset(otpVersion, assetName);
          await uploadAssets(octokit, uploadUrl, [archivedPath, sha256Path]);
        }
      } catch (e) {
        if (e instanceof Error) {
          error(`An error occured in ${otpVersion} process, name: ${e.name}, message: ${e.message}`);
        } else {
          error(`An error occured in ${otpVersion} process, obj: ${e}`);
        }
      }
    }
  } catch (error) {
    setFailed(error.message);
  }
}

run();
