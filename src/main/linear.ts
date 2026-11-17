import type { IssueDetail, IssueDocument, IssueUpdate, LinearIssue, LinearMilestone, LinearProject, LinearPullRequest, LinearState, TeamMeta } from '../shared/types'

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
  const [teamData, labelData, milestoneData] = await Promise.all([
    gql<{
      teams: {
        nodes: {
          id: string
          issueEstimationType: string
          issueEstimationAllowZero: boolean
          issueEstimationExtended: boolean
          members: { nodes: { id: string; name: string; displayName: string; avatarUrl: string | null; active: boolean }[] }
          projects: { nodes: Omit<LinearProject, 'milestones'>[] }
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
    gql<{ issueLabels: { nodes: { id: string; name: string; color: string; isGroup: boolean; parent: { id: string } | null }[] } }>(
      apiKey,
      `query Labels($key: String!) {
        issueLabels(first: 250, filter: { or: [{ team: { key: { eq: $key } } }, { team: { null: true } }] }) {
          nodes { id name color isGroup parent { id } }
        }
      }`,
      { key: teamKey }
    ),
    // Separate and allowed to fail: nesting milestones in the projects query is "too complex" for Linear.
    gql<{ projectMilestones: { nodes: (LinearMilestone & { project: { id: string } | null })[] } }>(
      apiKey,
      `query Milestones { projectMilestones(first: 250) { nodes { id name targetDate sortOrder project { id } } } }`,
      {}
    ).catch(() => ({ projectMilestones: { nodes: [] } }))
  ])
  const team = teamData.teams.nodes[0]
  if (!team) return null
  const zero = team.issueEstimationAllowZero
  const scale = ESTIMATE_SCALES[team.issueEstimationType]
  const values = scale ? [...(zero ? [0] : []), ...scale.base, ...(team.issueEstimationExtended ? scale.extended : [])] : []
  const labels = labelData.issueLabels.nodes.filter((l) => !l.isGroup) // groups can't be put on an issue themselves
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
    projects: team.projects.nodes
      .map((p) => ({
        ...p,
        milestones: milestoneData.projectMilestones.nodes
          .filter((m) => m.project?.id === p.id)
          .map(({ project: _project, ...m }) => m)
          .sort((a, b) => a.sortOrder - b.sortOrder)
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color, groupId: l.parent?.id ?? null })).sort((a, b) => a.name.localeCompare(b.name)),
    labelGroups: labelData.issueLabels.nodes
      .filter((g) => g.isGroup && labels.some((l) => l.parent?.id === g.id))
      .map((g) => ({ id: g.id, name: g.name, color: g.color }))
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
  projectMilestone { id name }
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
  projectMilestone: { id: string; name: string } | null
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
    milestone: n.projectMilestone ? { id: n.projectMilestone.id, name: n.projectMilestone.name } : null,
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

const PERSON = 'name displayName avatarUrl'

// The full ticket for the detail panel: description, properties, sub-issues, links and comments.
export async function fetchIssueDetail(apiKey: string, issueId: string): Promise<IssueDetail> {
  type Person = { id?: string; name: string; displayName: string; avatarUrl: string | null } | null
  type St = { name: string; type: string; color: string }
  const { issue: n } = await gql<{
    issue: {
      id: string; identifier: string; title: string; url: string; description: string | null
      state: St; priority: number; estimate: number | null; dueDate: string | null; createdAt: string; updatedAt: string
      assignee: Person; creator: Person
      labels: { nodes: { id: string; name: string; color: string }[] }
      project: { name: string; color: string } | null
      projectMilestone: { name: string } | null
      cycle: { number: number; name: string | null } | null
      parent: { identifier: string; title: string; url: string } | null
      children: { nodes: { identifier: string; title: string; url: string; state: St }[] }
      attachments: { nodes: { title: string; subtitle: string | null; url: string }[] }
      comments: { nodes: { id: string; body: string; createdAt: string; user: Person; botActor: { name: string | null } | null; parent: { id: string } | null }[] }
    }
  }>(
    apiKey,
    `query Detail($id: String!) {
      issue(id: $id) {
        id identifier title url description priority estimate dueDate createdAt updatedAt
        state { name type color }
        assignee { id ${PERSON} } creator { id ${PERSON} }
        labels(first: 20) { nodes { id name color } }
        project { name color } projectMilestone { name } cycle { number name }
        parent { identifier title url }
        children(first: 50) { nodes { identifier title url state { name type color } } }
        attachments(first: 20) { nodes { title subtitle url } }
        comments(first: 100) { nodes { id body createdAt user { id ${PERSON} } botActor { name } parent { id } } }
      }
    }`,
    { id: issueId }
  )
  // Documents in their own query, so an error there still leaves the rest of the ticket.
  let documents: IssueDocument[] = []
  let documentsError: string | undefined
  try {
    const docs = await gql<{
      issue: { documents: { nodes: { id: string; title: string; url: string; content: string | null; updatedAt: string; updatedBy: Person }[] } }
    }>(
      apiKey,
      `query Docs($id: String!) { issue(id: $id) { documents(first: 10) { nodes { id title url content updatedAt updatedBy { ${PERSON} } } } } }`,
      { id: issueId }
    )
    documents = docs.issue.documents.nodes.map((x) => ({
      id: x.id,
      title: x.title || 'Untitled',
      url: x.url,
      content: x.content ?? '',
      updatedAt: x.updatedAt,
      updatedBy: x.updatedBy ? x.updatedBy.displayName || x.updatedBy.name : null
    }))
  } catch (err) {
    documentsError = (err as Error).message
  }
  const person = (p: Person): IssueDetail['assignee'] =>
    p ? { id: p.id ?? '', name: p.displayName || p.name, avatarUrl: p.avatarUrl } : null
  return {
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    description: n.description ?? '',
    state: n.state,
    priority: n.priority ?? 0,
    estimate: n.estimate ?? null,
    dueDate: n.dueDate,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    assignee: person(n.assignee),
    creator: person(n.creator),
    labels: n.labels.nodes,
    project: n.project,
    milestone: n.projectMilestone,
    cycle: n.cycle,
    parent: n.parent,
    children: n.children.nodes,
    attachments: n.attachments.nodes,
    comments: n.comments.nodes
      .map((c) => ({
        id: c.id,
        body: c.body,
        createdAt: c.createdAt,
        author: c.user ? c.user.displayName || c.user.name : c.botActor?.name ?? 'Linear',
        avatarUrl: c.user?.avatarUrl ?? null,
        parentId: c.parent?.id ?? null
      }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    documents,
    documentsError
  }
}

// Images pasted into Linear live on uploads.linear.app and need the API key to load.
const imageCache = new Map<string, string>()
export async function fetchLinearImage(apiKey: string, url: string): Promise<string | null> {
  if (!/^https:\/\/uploads\.linear\.app\//.test(url)) return null
  const hit = imageCache.get(url)
  if (hit) return hit
  const res = await fetch(url, { headers: { Authorization: apiKey } })
  if (!res.ok) return null
  const type = res.headers.get('content-type') ?? 'image/png'
  if (!type.startsWith('image/')) return null
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 15_000_000) return null
  const data = `data:${type};base64,${buf.toString('base64')}`
  if (imageCache.size > 100) imageCache.delete(imageCache.keys().next().value as string)
  imageCache.set(url, data)
  return data
}

// Issues the team completed since a date (moved to a Done-type state), for the usage page.
// Canceled issues aren't completed, so they don't count.
export async function fetchCompleted(
  apiKey: string,
  teamKey: string,
  since: Date,
  projectIds?: string[]
): Promise<{ id: string; identifier: string; title: string; completedAt: string; estimate: number | null }[]> {
  if (projectIds?.length === 0) return []
  const filter: Record<string, unknown> = { team: { key: { eq: teamKey } }, completedAt: { gte: since.toISOString() } }
  if (projectIds) filter.project = { id: { in: projectIds } }
  const out: { id: string; identifier: string; title: string; completedAt: string; estimate: number | null }[] = []
  let after: string | null = null
  for (let page = 0; page < 20; page++) {
    const data: {
      issues: { nodes: { id: string; identifier: string; title: string; completedAt: string | null; estimate: number | null }[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
    } = await gql(
      apiKey,
      `query Completed($filter: IssueFilter!, $after: String) {
        issues(filter: $filter, first: 100, after: $after) {
          nodes { id identifier title completedAt estimate }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { filter, after }
    )
    for (const n of data.issues.nodes) if (n.completedAt) out.push({ ...n, completedAt: n.completedAt })
    if (!data.issues.pageInfo.hasNextPage) break
    after = data.issues.pageInfo.endCursor
  }
  return out
}
