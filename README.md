# pr-train 🚃

`git pr-train` helps you manage your PR chain when you need split a long PR into smaller ones.

## What does it do?

If you have a chain of PRs, `git pr-train`:

1. Makes sure all your branches in the chain get updated when you modify any of them
2. Creates GitHub PRs for you with a table of contents

Doing those two things manually can be (very) tedious and frustrating, believe you me.

## Usage

Install with `npm i -g git-pr-train`.

Run `git pr-train --init` in your repo root to generate a `.pr-train.yml` file (don't forget to gitignore).

Now whenever you have a chain of branches, list them in `.pr-train.yml` to tell pr-train which branches form the chain, and you're good to go.

### Basic usage examples

- `git pr-train -p` will merge branches sequentially one into another and push
- `git pr-train -r -p -f` will rebase branches instead of merging and then push with `--force`.
- `git pr-train -h` to print usage information

### Automatically create GitHub PRs from chained branches

**Pre-requisite**: Create a `${HOME}/.pr-train` file with a single line which is your GH personal access token (you can create one [here](https://github.com/settings/tokens)). The `repo` scope, with ` Full control of private repositories` is needed.

Run `git pr-train -p --create-prs` to create GitHub PRs with a "content table" section. PR titles are taken from the commit message titles of each branch HEAD. You'll be prompted before the PRs are created.

If you run with `--create-prs` again, `pr-train` will only override the Table of Contents in your PR, it will _not_ change the rest of the PR descriptions.

**Pro-tip**: If you want to update the ToCs in your GitHub PRs, just update the PR titles and re-run pr train with `--create-prs` - it will do the right thing.

### Draft PRs

To create PRs in draft mode ([if your repo allows](https://docs.github.com/en/free-pro-team@latest/github/collaborating-with-issues-and-pull-requests/about-pull-requests#draft-pull-requests)),
pass the `-d` or `--draft` argument on the command line (in addition to `-c`/`--create-prs`).

You can also configure PRs to be created in draft mode by default if you add the following section to your `.pr-train.yml` file:

```yaml
prs:
  draft-by-default: true

trains:
  # etc
```

Specifying this option will allow you to omit the `-d`/`--draft` parameter (though you still need to specify `-c`/`--create-prs`) when you want to create/update PRs.

## Example with explanation

You finished coding a feature and now you have a patch that is over 1000 SLOCs long. That's a big patch. As a good citizen, you want to split the diff into multiple PRs, e.g.:

- `fred_billing-refactor_frontend_bits`
- `fred_billing-refactor_backend_bits`
- `fred_billing-refactor_tests`

That's what we call that a _PR train_.

If you modify a branch (or e.g. merge/rebase `fred_billing-refactor_frontend_bits` on top of `master`), you'll want all the other branches to receive the change. `git pr-train` does that by merging (or rebasing) each branch into their child branch (i.e., branch 1 into branch 2, branch 2 into branch 3 etc).

If you wish, it also makes sure there is a "combined" branch (which contains the code of all subbranches, and you can build it and run tests on it - please see the `Chained PR workflows` section below).

Now everytime you make a change to any branch in the train, run `git pr-train -p` to merge and push branches or `git pr-train -rpf` to rebase branches and force-push (if you prefer rebasing).

### `.pr-train.yml` config

The `.pr-train.yml` file contains simple configuration that describes your trains. For example, the "billing refactor" example from above would be expressed as:

```yml
trains:
  big billing refactoring:
    - fred_billing-refactor_frontend_bits
    - fred_billing-refactor_backend_bits
    - fred_billing-refactor_tests
  #
  # ...config for older trains follows...
```

With this config, `fred_billing-refactor_frontend_bits` branch will be the first one in the train and `fred_billing-refactor_tests` will be the last.

## Chained PR workflows

#### "One-by-one" workflow

If you want to merge your branches one by one from the "bottom" as they get LGTM'd (i.e., they compile, pass tests and make sense on their own):

1.  Merge the LGTM'd branch into `master`
2.  Merge `master` into next train branch (or rebase that branch on top of `master`)
3.  Change the GitHub PR base to `master` so that the diff only contains the expected changes
4.  Delete the merged branch from `.pr-train.yml`
5.  Run `git pr-train` to propagate the changes through the train

Note that steps 1-3 are not pr-train specific, that's just how one-by-one workflow generally works.

#### "Combined Branch" workflow

Sometimes, you may want to split your code into PRs that cannot be merged separately (e.g., code changes first, then tests and snapshot updates last). In those cases it might be useful to have a branch that combines code from all the subbranches - we call that a "combined branch". It points to the same commit as the last sub-branch in the train with the exception that the PR created for this branch would be based off `master` (i.e., it will contain the full diff).

The idea is that you get LGTMs for all sub-branches in the train and then the combined branch is what you merge into `master`.

If you want to use this workflow, add a combined branch to the train config like so:

```yml
trains:
  big billing refactoring:
    - fred_billing-refactor_frontend_bits
    - fred_billing-refactor_backend_bits
    - fred_billing-refactor_tests
    - fred_billing-refactor_combined:
        combined: true
  #
  # ...config for older trains follows...
```

Unlike the sub-branches, the combined branch doesn't need to exist when you run the command; `pr-train` will make sure it's created, and it points to the last sub-branch in the train. Just make sure it's listed as the last branch in the train config.

## Running PR train

Run `git pr-train` in your working dir when you're on any branch that belongs to a PR train. You don't have to be on the first branch, any branch will do. Use `-r/--rebase` option if you'd like to rebase branches on top of each other rather than merge (note: you will have to push with `git pr-train -pf` in that case).

`git pr-train -p` will merge/rebase and push your updated changes to remote `origin` (configurable via `--remote` option).

## No master? No problem!

_All your base are belong to us._ - CATS

Are you working in a repository that doesn't use `master` as the main (default) branch? 
For example, newer repos use `main` instead. 
Or do you have a different branch that you want all PR trains to use as a base?

Add a section to the top of the config like so:

```yml
prs:
  main-branch-name: main

trains:
  # existing train config
```

### Override the base branch when creating PRs

You can override the base branch to use when creating PRs by passing the `--base <branch-name>`. This takes precedence 
over the main branch specified in the config file.

e.g. `git pr-train -p -c -b feat/my-feature-base`

## Print the PR links to the terminal

To have the command output include a link to the PR that was created or updated,
simply add `print-urls: true` to the `prs` section of the config file.


## Contributing

You can check out this repo, perform changes and install the module globally by running:

```
npm install  -g
```

Then follow the instructions under [Usage](#Usage) in order to test.