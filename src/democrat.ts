import * as github from '@actions/github'
import * as octokit from '@octokit/types'
import { GitHub } from '@actions/github/lib/utils'

type logFunction = (level: string, message: string) => void

export interface DemocratParameters {
  readonly token: string
  readonly owner: string
  readonly repo: string
  readonly voters: string[]
  readonly dryRun: boolean
  readonly logFunction: logFunction
}

export interface PullRequestParameters {
  readonly minimumReviewScore: number
  readonly votingTimeHours: number
  readonly markAsMergeableLabel: string
  readonly targetBranch: string
}

interface PullCandidate {
  readonly number: number
  readonly mergeable: boolean
  readonly updatedAt: Date
  readonly labels: (string | undefined)[]
  readonly base: string
  readonly reviewScore: number
}

type listPullsData = octokit.Endpoints['GET /repos/{owner}/{repo}/pulls']['response']['data']
type getPullData = octokit.Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}']['response']['data']
type listReviewsData = octokit.Endpoints['GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews']['response']['data']

export default class Democrat {
  private democratParameters: DemocratParameters
  private pullRequestParameters: PullRequestParameters
  private octokit: InstanceType<typeof GitHub>
  private logger: logFunction

  constructor(democratParameters: DemocratParameters, pullRequestParameters: PullRequestParameters) {
    this.democratParameters = democratParameters
    this.pullRequestParameters = pullRequestParameters
    /* eslint-disable no-console */
    this.logger = democratParameters.logFunction || ((level, message) => console.log(`${level} - ${message}`))
    /* eslint-enable no-console */
    this.octokit = github.getOctokit(democratParameters.token)
  }

  async votingOpening(pullNumber: number): Promise<void> {
    const { owner, repo, voters, dryRun } = this.democratParameters
    const { targetBranch, markAsMergeableLabel, votingTimeHours, minimumReviewScore } = this.pullRequestParameters
    const votersLink = voters.map((voter) => `[${voter}](https://github.com/${voter})`)
    const body = `
## The Github Democrat is now taking care of this pull request. Voting is open!

To be eligible for merge, the pull request must:
- be mergeable (no conflicts)
- target the branch \`${targetBranch}\`
- have a \`${markAsMergeableLabel}\` label
- have been unmodified for \`${votingTimeHours}h\`
- have a review score of \`${minimumReviewScore}\` or more (approves +1 & request changes -1)

Allowed voters are: ${voters.length > 0 ? votersLink.join(', ') : ':open_hands: everyone :open_hands:'}
    `

    if (dryRun) {
      this.logger(
        'info',
        `Dry-run enabled. The following comment will not be created one the pull request #${pullNumber}: ${body}`
      )

      return
    }

    this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    })
  }

  async enforceDemocracy(): Promise<void> {
    const { owner, repo } = this.democratParameters
    this.logger('info', `Implementing democracy on ${owner}/${repo}, resistance is futile.`)

    const pulls = await this.fetchPulls()
    this.logger('info', `${pulls.length} pull request(s) is/are candidate(s) for merge.`)
    const pullsAndReviews = await this.fetchPullDetailsAndReviews(pulls)
    const pullCandidates = this.buildPullCandidates(pullsAndReviews)
    const electedPullCandidates = pullCandidates.filter((pull) => {
      const errors = this.validatePullCandidate(pull)

      if (errors.length > 0) {
        this.logger('info', `Pull request #${pull.number} did not pass validation. Errors: ${errors.join(', ')}.`)

        return false
      }

      return true
    })
    this.logger('info', `${electedPullCandidates.length} pull request(s) left after validation.`)

    await this.mergePulls(electedPullCandidates)

    this.logger('info', 'Democracy enforcer will be back.')
  }

  private async fetchPulls(): Promise<listPullsData> {
    const { owner, repo } = this.democratParameters

    const response = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: 'open',
    })

    return response.data
  }

  private async fetchPullDetailsAndReviews(pulls: listPullsData): Promise<[getPullData, listReviewsData][]> {
    const promises: Promise<[getPullData, listReviewsData]>[] = pulls.map(
      async ({ number: pullRequestNumber }) =>
        new Promise(async (resolve, reject) => {
          const pull = this.fetchPullDetails(pullRequestNumber)
          const reviews = this.fetchReviews(pullRequestNumber)

          try {
            const all = await Promise.all([pull, reviews])
            resolve(all)
          } catch (error) {
            reject(error)
          }
        })
    )

    return Promise.all(promises)
  }

  private async fetchPullDetails(pullNumber: number): Promise<getPullData> {
    const { owner, repo } = this.democratParameters

    const response = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    })

    return response.data
  }

  private async fetchReviews(pullNumber: number): Promise<listReviewsData> {
    const { owner, repo } = this.democratParameters

    const response = await this.octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
    })

    return response.data
  }

  private buildPullCandidates(pullsAndReviews: [getPullData, listReviewsData][]): PullCandidate[] {
    const pullCandidates = []

    for (const [pull, reviews] of pullsAndReviews) {
      pullCandidates.push(this.buildPullCandidate(pull, reviews))
    }

    return pullCandidates
  }

  private buildPullCandidate(pull: getPullData, reviews: listReviewsData): PullCandidate {
    const { voters } = this.democratParameters

    return {
      number: pull.number,
      mergeable: !!pull.mergeable,
      updatedAt: new Date(pull.updated_at),
      labels: pull.labels.map((label) => label.name),
      base: pull.base.ref,
      reviewScore: reviews.reduce((accumulator, review): number => {
        if (voters.length > 0 && (!review?.user?.login || -1 === voters.indexOf(review.user.login))) {
          return accumulator
        }

        if ('APPROVED' === review.state) {
          accumulator += 1
        }

        if ('CHANGES_REQUESTED' === review.state) {
          accumulator += -1
        }

        return accumulator
      }, 0),
    }
  }

  private validatePullCandidate(pullCandidate: PullCandidate): string[] {
    const errors = []
    const { minimumReviewScore, votingTimeHours, markAsMergeableLabel, targetBranch } = this.pullRequestParameters
    const lastCommitSinceHours = (+new Date() - pullCandidate.updatedAt.getTime()) / (1000 * 60 * 60)
    const hasMergeableLabel = -1 !== pullCandidate.labels.indexOf(markAsMergeableLabel)

    pullCandidate.mergeable || errors.push('not mergeable')
    pullCandidate.reviewScore >= minimumReviewScore || errors.push(`review score too low: ${pullCandidate.reviewScore}`)
    lastCommitSinceHours > votingTimeHours ||
      errors.push(`not mature enough (last commit ${lastCommitSinceHours.toPrecision(1)}h ago)`)
    hasMergeableLabel || errors.push(`missing \`${markAsMergeableLabel}\` label`)
    targetBranch === pullCandidate.base ||
      errors.push(`wrong target branch: ${pullCandidate.base} instead of ${targetBranch}`)

    return errors
  }

  private async mergePulls(pulls: PullCandidate[]): Promise<void[]> {
    const promises = pulls.map(async (pull) => this.mergePull(pull))

    return Promise.all(promises)
  }

  private async mergePull(pull: PullCandidate): Promise<void> {
    const { owner, repo, dryRun } = this.democratParameters
    this.logger('info', `Democracy has spoken. Pull Request #${pull.number} has been voted for merge.`)

    if (dryRun === true) {
      this.logger('info', `Dry-run enabled. Pull Request #${pull.number} will not be merged.`)

      return new Promise((resolve) => resolve(undefined))
    }

    await this.commentMergePull(pull)
    await this.octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: pull.number,
      merge_method: 'squash',
    })

    return this.logger('info', `Pull Request #${pull.number} merged.`)
  }

  private async commentMergePull(pull: PullCandidate): Promise<void> {
    const { owner, repo } = this.democratParameters
    const body = `Democracy has spoken, the pull request will be merged.`

    this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pull.number,
      body,
    })
  }
}
