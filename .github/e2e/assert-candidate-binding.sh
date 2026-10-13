#!/usr/bin/env bash

set -euo pipefail

reject() {
  echo "$1" >&2
  exit 1
}

: "${GH_TOKEN:?}" "${REPOSITORY:?}" "${DEFAULT_BRANCH:?}" "${CANDIDATE_MODE:?}" "${CANDIDATE_SHA:?}"
sha_pattern='^[a-f0-9]{40}$'
[[ "$CANDIDATE_SHA" =~ $sha_pattern ]] || reject "candidate_sha must be a full lowercase commit SHA"

# Admission runs from github.workflow_sha with a read-only token. Later calls
# revalidate the bound candidate immediately before execution and after cleanup.
stage="${1:-revalidate}"
case "$stage" in
  admit)
    : "${WORKFLOW_REF:?}" "${WORKFLOW_SHA:?}" "${DISPATCH_SHA:?}" "${ACTOR:?}" "${APPROVED_CANDIDATE_SHA:?}" "${GITHUB_OUTPUT:?}" "${GITHUB_STEP_SUMMARY:?}"
    [[ "$WORKFLOW_REF" == "refs/heads/$DEFAULT_BRANCH" ]] || reject "E2E must be dispatched from the default branch workflow"
    [[ "$WORKFLOW_SHA" =~ $sha_pattern && "$DISPATCH_SHA" == "$WORKFLOW_SHA" ]] || reject "The dispatched commit must be the immutable full workflow SHA"
    default_sha="$(gh api "repos/$REPOSITORY/git/ref/heads/$DEFAULT_BRANCH" --jq .object.sha)"
    [[ "$DISPATCH_SHA" == "$default_sha" ]] || reject "The dispatch SHA must equal the live default-branch SHA"
    [[ "$APPROVED_CANDIDATE_SHA" == "$CANDIDATE_SHA" ]] || reject "DSH_E2E_CANDIDATE_SHA must exactly match candidate_sha"
    permission="$(gh api "repos/$REPOSITORY/collaborators/$ACTOR/permission" --jq .permission)"
    [[ "$permission" == "write" || "$permission" == "maintain" || "$permission" == "admin" ]] || reject "The triggering actor must have repository write permission"
    # workflow_dispatch's omitted numeric input can arrive as either empty or 0.
    if [[ "$CANDIDATE_MODE" == "main" && "${CANDIDATE_PR:-}" == "0" ]]; then
      CANDIDATE_PR=""
    fi
    ;;
  revalidate) ;;
  *)
    reject "Unsupported candidate check stage: $stage"
    ;;
esac

case "$CANDIDATE_MODE" in
  pull-request)
    : "${CANDIDATE_PR:?}"
    [[ "$CANDIDATE_PR" =~ ^[1-9][0-9]*$ ]] || reject "pull_request must be a positive integer in pull-request mode"
    pr_json="$(gh api "repos/$REPOSITORY/pulls/$CANDIDATE_PR")"
    jq -e --arg sha "$CANDIDATE_SHA" --arg repo "${REPOSITORY,,}" --arg base "$DEFAULT_BRANCH" '
      .state == "open" and .draft == false and .head.sha == $sha and
      (.head.repo.full_name | ascii_downcase) == $repo and
      (.base.repo.full_name | ascii_downcase) == $repo and .base.ref == $base
    ' <<<"$pr_json" >/dev/null || reject "The open same-repository PR must still bind the candidate SHA and default branch"
    candidate_branch="$(jq -r .head.ref <<<"$pr_json")"
    summary="Bound PR #$CANDIDATE_PR to candidate $CANDIDATE_SHA"
    ;;
  main)
    [[ -z "${CANDIDATE_PR:-}" ]] || reject "pull_request must be omitted in main mode"
    live_sha="$(gh api "repos/$REPOSITORY/git/ref/heads/$DEFAULT_BRANCH" --jq .object.sha)"
    [[ "$live_sha" =~ $sha_pattern && "$live_sha" == "$CANDIDATE_SHA" ]] || reject "main mode requires candidate_sha to equal the live default-branch SHA"
    if [[ "$stage" == "admit" ]]; then
      [[ "$CANDIDATE_SHA" == "$DISPATCH_SHA" ]] || reject "main mode requires candidate_sha to equal the immutable dispatched commit"
    fi
    candidate_branch="$DEFAULT_BRANCH"
    summary="Bound post-merge qualification to live $DEFAULT_BRANCH commit $CANDIDATE_SHA"
    ;;
  *)
    reject "Unsupported candidate mode: $CANDIDATE_MODE"
    ;;
esac

if [[ "$stage" == "admit" ]]; then
  {
    echo "run_e2e=true"
    echo "candidate_mode=$CANDIDATE_MODE"
    echo "candidate_sha=$CANDIDATE_SHA"
    echo "candidate_branch=$candidate_branch"
    echo "pull_request=${CANDIDATE_PR:-}"
    echo "harness_sha=$DISPATCH_SHA"
  } >> "$GITHUB_OUTPUT"
  echo "$summary from the trusted default-branch workflow" >> "$GITHUB_STEP_SUMMARY"
fi
