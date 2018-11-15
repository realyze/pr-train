// @ts-check
const octo = require('octonode');
const promptly = require('promptly');
const {
  DEFAULT_REMOTE
} = require('./consts');
const fs = require('fs');
const colors = require('colors');
const emoji = require('node-emoji');
const simpleGit = require('simple-git/promise');

/**
 *
 * @param {simpleGit.SimpleGit} sg
 * @param {string} branch
 * @return Promise.<{title: string, body: string}>
 */
async function constructPrMsg(sg, branch) {
  const title = await sg.raw(['log', '--format=%s', '-n', '1', branch]);
  const body = await sg.raw(['log', '--format=%b', '-n', '1', branch]);
  return {
    title: title.trim(),
    body: body.trim(),
  };
}

/**
 *
 * @param {Object.<string, {title: string, pr: number}>} branchToPrDict
 * @param {string} currentBranch
 * @param {string} combinedBranch
 */
function constructTrainNavigation(branchToPrDict, currentBranch, combinedBranch) {
  let contents = '<pr-train-toc>\n\n#### PR chain:\n';
  contents = Object.keys(branchToPrDict).reduce((output, branch) => {
    const maybeHandRight = branch === currentBranch ? '👉 ' : '';
    const maybeHandLeft = branch === currentBranch ? ' 👈 **YOU ARE HERE**' : '';
    const combinedInfo = branch === combinedBranch ? ' **[combined branch]** ' : ' ';
    output += `${maybeHandRight}#${branchToPrDict[branch].pr}${combinedInfo}(${branchToPrDict[
      branch
    ].title.trim()})${maybeHandLeft}`;
    return output + '\n';
  }, contents);
  contents += '\n</pr-train-toc>';
  return contents;
}

function checkGHKeyExists() {
  try {
    readGHKey()
  } catch (e) {
    console.log(`"$HOME/.pr-train" not found. Please make sure file exists and contains your GitHub API key.`.red);
    process.exit(4);
  }
}

function readGHKey() {
  return fs
    .readFileSync(`${process.env.HOME}/.pr-train`, 'UTF-8')
    .toString()
    .trim();
}

/**
 *
 * @param {string} newNavigation
 * @param {string} body
 */
function upsertNavigationInBody(newNavigation, body) {
  if (body.match(/<pr-train-toc>/)) {
    return body.replace(/<pr-train-toc>[^]*<\/pr-train-toc>/, newNavigation);
  } else {
    return body + '\n' + newNavigation;
  }
}

/**
 *
 * @param {simpleGit.SimpleGit} sg
 * @param {Array.<string>} allBranches
 * @param {string} combinedBranch
 * @param {string} remote
 */
async function ensurePrsExist(sg, allBranches, combinedBranch, remote = DEFAULT_REMOTE) {
  //const allBranches = combinedBranch ? sortedBranches.concat(combinedBranch) : sortedBranches;
  const octoClient = octo.client(readGHKey());
  // TODO: take remote name from `-r` value.
  const remoteUrl = await sg.raw(['config', '--get', `remote.${remote}.url`]);
  if (!remoteUrl) {
    console.log(`URL for remote ${remote} not found in your git config`.red);
    process.exit(4);
  }

  /** @type string */
  let combinedBranchTitle;
  if (combinedBranch) {
    console.log();
    console.log(`Now I will need to know what to call your "combined" branch PR in GitHub.`);
    combinedBranchTitle = await promptly.prompt(colors.bold(`Combined branch PR title:`));
    if (!combinedBranchTitle) {
      console.log(`Cannot continue.`.red, `(I need to know what the title of your combined branch PR should be.)`);
      process.exit(5);
    }
  }

  const getCombinedBranchPrMsg = () => ({
    title: combinedBranchTitle,
    body: '',
  });

  console.log();
  console.log('This will create (or update) PRs for the following branches:');
  await allBranches.reduce(async (memo, branch) => {
    await memo;
    const {
      title
    } = branch === combinedBranch ? getCombinedBranchPrMsg() : await constructPrMsg(sg, branch);
    console.log(`  -> ${branch.green} (${title.italic})`);
  }, Promise.resolve());

  console.log();
  if (!(await promptly.confirm(colors.bold('Shall we do this? [y/n] ')))) {
    console.log('No worries. Bye now.', emoji.get('wave'));
    process.exit(0);
  }

  const nickAndRepo = remoteUrl.match(/github\.com[/:](.*)\.git/)[1];
  if (!nickAndRepo) {
    console.log(`I could not parse your remote ${remote} repo URL`.red);
    process.exit(4);
  }

  const nick = nickAndRepo.split('/')[0];
  const ghRepo = octoClient.repo(nickAndRepo);

  console.log('');
  // Construct branch_name <-> PR_data mapping.
  // Note: We're running this serially to have nicer logs.
  /**
   * @type Object.<string, {title: string, pr: number, body: string, updating: boolean}>
   */
  const prDict = await allBranches.reduce(async (_memo, branch, index) => {
    const memo = await _memo;
    const {
      title,
      body
    } = branch === combinedBranch ? getCombinedBranchPrMsg() : await constructPrMsg(sg, branch);
    const base = index === 0 || branch === combinedBranch ? 'master' : allBranches[index - 1];
    process.stdout.write(`Checking if PR for branch ${branch} already exists... `);
    const prs = await ghRepo.prsAsync({
      head: `${nick}:${branch}`,
    });
    let prResponse = prs[0] && prs[0][0];
    let prExists = false;
    if (prResponse) {
      console.log('yep');
      prExists = true;
    } else {
      console.log('nope');
      const payload = {
        head: branch,
        base,
        title,
        body,
      };
      process.stdout.write(`Creating PR for branch "${branch}"...`);
      try {
        prResponse = (await ghRepo.prAsync(payload))[0];
      } catch (e) {
        console.error(JSON.stringify(e, null, 2));
        throw e;
      }
      console.log(emoji.get('white_check_mark'));
    }
    memo[branch] = {
      body: prResponse.body,
      title: prResponse.title,
      pr: prResponse.number,
      updating: prExists,
    };
    return memo;
  }, Promise.resolve({}));

  // Now that we have all the PRs, let's update them with the "navigation" section.
  // Note: We're running this serially to have nicer logs.
  await allBranches.reduce(async (memo, branch) => {
    await memo;
    const prInfo = prDict[branch];
    const ghPr = octoClient.pr(nickAndRepo, prInfo.pr);
    const {
      title,
      body
    } = prInfo.updating ?
      prInfo // Updating existing PR: keep current body and title.
      :
      branch === combinedBranch ?
      getCombinedBranchPrMsg() :
      await constructPrMsg(sg, branch);
    const navigation = constructTrainNavigation(prDict, branch, combinedBranch);
    const newBody = upsertNavigationInBody(navigation, body);
    process.stdout.write(`Updating PR for branch ${branch}...`);
    await ghPr.updateAsync({
      title,
      body: `${newBody}`,
    });
    console.log(emoji.get('white_check_mark'));
  }, Promise.resolve());
}

module.exports = {
  ensurePrsExist,
  readGHKey,
  checkGHKeyExists,
};
