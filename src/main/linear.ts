import type { IssueUpdate, LinearIssue, LinearProject, LinearPullRequest, LinearState, TeamMeta } from '../shared/types'

const ENDPOINT = 'https://api.linear.app/graphql'

async function gql<T>(apiKey: string, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables })
  })
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (!res.ok || json.errors?.length) {
    throw new Error(json.errors?.map((e) => e.message).join('; ') || `Linear returned ${res.status}`)
  }
  return json.data as T
}

export async function fetchStates(apiKey: string, teamKey: string): Promise<LinearState[]> {
  const data = await gql<{ workflowStates: { nodes: LinearState[] } }>(
    apiKey,
    `query States($key: String!) {
      workflowStates(filter: { team: { key: { eq: $key } } }, first: 100) {
        nodes { id name type position color }
      }
    }`,
    { key: teamKey }
  )
  return data.workflowStates.nodes.sort((a, b) => a.position - b.position)
}

// Estimate scales as Linear defines them per team. Extended adds the larger values.
const ESTIMATE_SCALES: Record<string, { base: number[]; extended: number[] }> = {
  exponential: { base: [1, 2, 4, 8, 16], extended: [32, 64] },
  fibonacci: { base: [1, 2, 3, 5, 8], extended: [13, 21] },
  linear: { base: [1, 2, 3, 4, 5], extended: [6, 7, 8, 9, 10] },
  tShirt: { base: [1, 2, 3, 5, 8], extended: [13, 21] }
}
const TSHIRT = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL']

// The team's members, labels and estimate scale: what the card menus offer.
// Two small queries: one combined query is over Linear's complexity limit.
export async function fetchTeamMeta(apiKey: string, teamKey: string): Promise<TeamMeta | null> {
  const [teamData, labelData] = await Promise.all([
    gql<{
      teams: {
        nodes: {
          id: string
          issueEstimationType: string
          issueEstimationAllowZero: boolean
          issueEstimationExtended: boolean
          members: { nodes: { id: string; name: string; displayName: string; avatarUrl: string | null; active: boolean }[] }
          projects: { nodes: LinearProject[] }
        }[]
      }
    }>(
      apiKey,
      `query Team($key: String!) {
        teams(first: 1, filter: { key: { eq: $key } }) {
          nodes {
            id issueEstimationType issueEstimationAllowZero issueEstimationExtended
            members(first: 100) { nodes { id name displayName avatarUrl active } }
            projects(first: 100) { nodes { id name color state } }
          }
        }
      }`,
      { key: teamKey }
    ),
    gql<{ issueLabels: { nodes: { id: string; name: string; color: string; isGroup: boolean }[] } }>(
      apiKey,
      `query Labels($key: String!) {
        issueLabels(first: 250, filter: { or: [{ team: { key: { eq: $key } } }, { team: { null: true } }] }) {
          nodes { id name color isGroup }
        }
      }`,
      { key: teamKey }
    )
  ])
  const team = teamData.teams.nodes[0]
  if (!team) return null
  const zero = team.issueEstimationAllowZero
  const scale = ESTIMATE_SCALES[team.issueEstimationType]
  const values = scale ? [...(zero ? [0] : []), ...scale.base, ...(team.issueEstimationExtended ? scale.extended : [])] : []
  return {
    id: team.id,
    estimates: values.map((v, i) => ({
      value: v,
      label: team.issueEstimationType === 'tShirt' && v !== 0 ? TSHIRT[i - (zero ? 1 : 0)] ?? String(v) : String(v)
    })),
    members: team.members.nodes
      .filter((m) => m.active)
      .map((m) => ({ id: m.id, name: m.displayName || m.name, avatarUrl: m.avatarUrl }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    projects: [...team.projects.nodes].sort((a, b) => a.name.localeCompare(b.name)),
    labels: labelData.issueLabels.nodes
      .filter((l) => !l.isGroup) // groups can't be put on an issue themselves
      .map((l) => ({ id: l.id, name: l.name, color: l.color }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }
}

const ISSUE_FIELDS = `
  id identifier title url branchName priority estimate createdAt sortOrder
  state { id name }
  labels(first: 10) { nodes { id name color } }
  assignee { id name displayName avatarUrl }
  parent { identifier title }
  project { id }
  children(first: 50) { nodes { state { type } } }
  inverseRelations(first: 20) { nodes { type } }
  attachments(first: 10) { nodes { url title sourceType metadata } }
`

interface IssueNode {
  id: string
  identifier: string
  title: string
  url: string
  branchName: string
  state: { id: string; name: string }
  labels: { nodes: { id: string; name: string; color: string }[] }
  priority: number
  estimate: number | null
  createdAt: string
  sortOrder: number
  assignee: { id: string; name: string; displayName: string; avatarUrl: string | null } | null
  parent: { identifier: string; title: string } | null
  project: { id: string } | null
  children: { nodes: { state: { type: string } }[] }
  inverseRelations: { nodes: { type: string }[] }
  attachments: { nodes: { url: string; title: string; sourceType: string | null; metadata: Record<string, unknown> | null }[] }
}

const PR_URL = /\/pull\/(\d+)/

function pullRequests(n: IssueNode): LinearPullRequest[] {
  const seen = new Set<string>()
  const out: LinearPullRequest[] = []
  for (const a of n.attachments.nodes) {
    const m = PR_URL.exec(a.url)
    if (!m || seen.has(a.url)) continue
    seen.add(a.url)
    const meta = a.metadata ?? {}
    const raw = String(meta.status ?? meta.state ?? '').toLowerCase()
    const status: LinearPullRequest['status'] =
      meta.draft === true || raw === 'draft'
        ? 'draft'
        : raw === 'merged' || meta.merged === true
          ? 'merged'
          : raw === 'closed'
            ? 'closed'
            : raw === 'open' || raw === 'opened'
              ? 'open'
              : 'unknown'
    out.push({ number: m[1], url: a.url, status })
  }
  return out
}

// Deploy previews (Vercel and similar) show up as attachments titled "Preview ...".
function previewUrl(n: IssueNode): string | null {
  const a = n.attachments.nodes.find((x) => !PR_URL.test(x.url) && /preview/i.test(`${x.title} ${x.url}`))
  return a?.url ?? null
}

function toIssue(n: IssueNode): LinearIssue {
  const kids = n.children.nodes
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    branchName: n.branchName,
    stateId: n.state.id,
    stateName: n.state.name,
    labels: n.labels.nodes.map((l) => ({ id: l.id, name: l.name, color: l.color })),
    priority: n.priority ?? 0,
    estimate: n.estimate ?? null,
    createdAt: n.createdAt,
    sortOrder: n.sortOrder ?? 0,
    assignee: n.assignee
      ? { id: n.assignee.id, name: n.assignee.displayName || n.assignee.name, avatarUrl: n.assignee.avatarUrl }
      : null,
    parent: n.parent,
    projectId: n.project?.id ?? null,
    blocked: n.inverseRelations.nodes.some((r) => r.type === 'blocks'),
    subIssues: kids.length
      ? { done: kids.filter((k) => k.state.type === 'completed' || k.state.type === 'canceled').length, total: kids.length }
      : null,
    pullRequests: pullRequests(n),
    previewUrl: previewUrl(n)
  }
}

// Fetches issues in the given states only, so a large backlog never gets pulled.
// projectIds limits it to those Linear projects; undefined means every project.
export async function fetchIssues(apiKey: string, teamKey: string, stateIds: string[], projectIds?: string[]): Promise<LinearIssue[]> {
  if (!stateIds.length || projectIds?.length === 0) return []
  const filter: Record<string, unknown> = { team: { key: { eq: teamKey } }, state: { id: { in: stateIds } } }
  if (projectIds) filter.project = { id: { in: projectIds } }
  const out: LinearIssue[] = []
  let after: string | null = null
  // 50 per page keeps the nested connections under Linear's query complexity limit.
  for (let page = 0; page < 20; page++) {
    const data: {
      issues: { nodes: IssueNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
    } = await gql(
      apiKey,
      `query Issues($filter: IssueFilter!, $after: String) {
        issues(
          filter: $filter
          first: 50
          after: $after
          orderBy: updatedAt
        ) {
          nodes { ${ISSUE_FIELDS} }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, after }
    )
    for (const n of data.issues.nodes) out.push(toIssue(n))
    if (!data.issues.pageInfo.hasNextPage) break
    after = data.issues.pageInfo.endCursor
  }
  return out
}

// Re-reads one issue so the board shows what Linear holds after a change.
export async function fetchIssue(apiKey: string, issueId: string): Promise<LinearIssue> {
  const data = await gql<{ issue: IssueNode }>(apiKey, `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, {
    id: issueId
  })
  return toIssue(data.issue)
}

export async function updateIssue(apiKey: string, issueId: string, input: IssueUpdate): Promise<void> {
  const data = await gql<{ issueUpdate: { success: boolean } }>(
    apiKey,
    `mutation Update($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id: issueId, input }
  )
  if (!data.issueUpdate.success) throw new Error('Linear did not accept the change')
}

export async function moveIssue(apiKey: string, issueId: string, stateId: string): Promise<void> {
  await updateIssue(apiKey, issueId, { stateId })
}

// The issue's labels and team, and a label of that name the team can use (team or workspace), if any.
async function issueAndLabel(apiKey: string, issueId: string, name: string): Promise<{ teamId: string; labelIds: string[]; label: string | null }> {
  const data = await gql<{
    issue: { team: { id: string }; labels: { nodes: { id: string; name: string }[] } }
    issueLabels: { nodes: { id: string; team: { id: string } | null }[] }
  }>(
    apiKey,
    `query FailLabel($id: String!, $name: String!) {
      issue(id: $id) { team { id } labels(first: 50) { nodes { id name } } }
      issueLabels(first: 20, filter: { name: { eqIgnoreCase: $name } }) { nodes { id team { id } } }
    }`,
    { id: issueId, name }
  )
  const teamId = data.issue.team.id
  const own = data.issue.labels.nodes.find((l) => l.name.toLowerCase() === name.toLowerCase())
  const usable = data.issueLabels.nodes.find((l) => l.team?.id === teamId) ?? data.issueLabels.nodes.find((l) => !l.team)
  return { teamId, labelIds: data.issue.labels.nodes.map((l) => l.id), label: own?.id ?? usable?.id ?? null }
}

// Adds a label by name, creating it on the issue's team if it doesn't exist yet.
export async function addLabelByName(apiKey: string, issueId: string, name: string): Promise<void> {
  const { teamId, labelIds, label } = await issueAndLabel(apiKey, issueId, name)
  let id = label
  if (id && labelIds.includes(id)) return
  if (!id) {
    const made = await gql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
      apiKey,
      `mutation MakeLabel($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
      { input: { name, teamId, color: '#eb5757' } }
    )
    id = made.issueLabelCreate.issueLabel.id
  }
  await updateIssue(apiKey, issueId, { labelIds: [...labelIds, id] })
}

// Removes a label by name; false when the issue didn't have it.
export async function removeLabelByName(apiKey: string, issueId: string, name: string): Promise<boolean> {
  const data = await gql<{ issue: { labels: { nodes: { id: string; name: string }[] } } }>(
    apiKey,
    `query Labels($id: String!) { issue(id: $id) { labels(first: 50) { nodes { id name } } } }`,
    { id: issueId }
  )
  const all = data.issue.labels.nodes
  const keep = all.filter((l) => l.name.toLowerCase() !== name.toLowerCase())
  if (keep.length === all.length) return false
  await updateIssue(apiKey, issueId, { labelIds: keep.map((l) => l.id) })
  return true
}

export async function addComment(apiKey: string, issueId: string, body: string): Promise<void> {
  await gql(apiKey, `mutation Comment($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`, { input: { issueId, body } })
}
