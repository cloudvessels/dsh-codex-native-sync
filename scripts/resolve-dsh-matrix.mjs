import fs from 'node:fs';
import {compareDshVersions,fetchOfficialDshReleaseWindow} from './vendor/official-dsh-releases.mjs';

const window=await fetchOfficialDshReleaseWindow({githubToken:process.env.GITHUB_TOKEN,timeoutMs:30000});
if(window.releaseCount!==3||window.releases.length!==3||window.latestVersion!==window.releases[2])throw Error('Incomplete official window');
const next=window.channels.find(row=>row.tag==='next');
const nextVersion=next&&compareDshVersions(next.version,window.latestVersion)>0?next.version:'';
const versions=[...new Set([...window.releases,...(nextVersion?[nextVersion]:[])])];
const report={...window,checkedAt:new Date().toISOString(),nextVersion,matrixVersions:versions};
if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,'versions='+JSON.stringify(versions)+'\n');
console.log(JSON.stringify(report,null,2));
