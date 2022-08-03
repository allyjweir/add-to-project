import * as core from '@actions/core'
import * as github from '@actions/github'

// TODO: Ensure this (and the Octokit client) works for non-github.com URLs, as well.
// https://github.com/orgs|users/<ownerName>/projects/<projectNumber>
const urlParse =
  /^(?:https:\/\/)?github\.com\/(?<ownerType>orgs|users)\/(?<ownerName>[^/]+)\/projects\/(?<projectNumber>\d+)/

type OwnerQueryTypes = 'organization' | 'user'

interface ProjectNodeIDResponse {
  organization?: {
    projectV2: {
      id: string
    }
  }

  user?: {
    projectV2: {
      id: string
    }
  }
}

interface ProjectAddItemResponse {
  addProjectV2ItemById: {
    item: {
      id: string
    }
  }
}

interface ProjectV2AddDraftIssueResponse {
  addProjectV2DraftIssue: {
    projectItem: {
      id: string
    }
  }
}

interface ProjectV2FieldIDResponse {
  organization?: {
    projectV2: {
      field: {
        id: string
        options: {
          id: string
          name: string
        }[]
      }
    }
  }

  user?: {
    projectV2: {
      id: string
      field: {
        id: string
        options: {
          id: string
          name: string
        }[]
      }
    }
  }
}

interface ProjectV2UpdateItemFieldValueResponse {
  updateProjectV2ItemFieldValue: {
    projectV2Item: {
      updatedAt: string
    }
  }
}

export async function addToProject(): Promise<void> {
  const projectUrl = core.getInput('project-url', {required: true})
  const ghToken = core.getInput('github-token', {required: true})
  const labeled =
    core
      .getInput('labeled')
      .split(',')
      .map(l => l.trim().toLowerCase())
      .filter(l => l.length > 0) ?? []
  const labelOperator = core.getInput('label-operator').trim().toLocaleLowerCase()

  const octokit = github.getOctokit(ghToken)

  const issue = github.context.payload.issue ?? github.context.payload.pull_request
  const issueLabels: string[] = (issue?.labels ?? []).map((l: {name: string}) => l.name.toLowerCase())
  const issueOwnerName = github.context.payload.repository?.owner.login

  core.debug(`Issue/PR owner: ${issueOwnerName}`)

  // Ensure the issue matches our `labeled` filter based on the label-operator.
  if (labelOperator === 'and') {
    if (!labeled.every(l => issueLabels.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it doesn't match all the labels: ${labeled.join(', ')}`)
      return
    }
  } else if (labelOperator === 'not') {
    if (labeled.length > 0 && issueLabels.some(l => labeled.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it contains one of the labels: ${labeled.join(', ')}`)
      return
    }
  } else {
    if (labeled.length > 0 && !issueLabels.some(l => labeled.includes(l))) {
      core.info(`Skipping issue ${issue?.number} because it does not have one of the labels: ${labeled.join(', ')}`)
      return
    }
  }

  core.debug(`Project URL: ${projectUrl}`)

  const urlMatch = projectUrl.match(urlParse)

  if (!urlMatch) {
    throw new Error(
      `Invalid project URL: ${projectUrl}. Project URL should match the format https://github.com/<orgs-or-users>/<ownerName>/projects/<projectNumber>`
    )
  }

  const projectOwnerName = urlMatch.groups?.ownerName
  const projectNumber = parseInt(urlMatch.groups?.projectNumber ?? '', 10)
  const ownerType = urlMatch.groups?.ownerType
  const ownerTypeQuery = mustGetOwnerTypeQuery(ownerType)

  core.debug(`Project owner: ${projectOwnerName}`)
  core.debug(`Project number: ${projectNumber}`)
  core.debug(`Project owner type: ${ownerType}`)

  // First, use the GraphQL API to request the project's node ID.
  const idResp = await octokit.graphql<ProjectNodeIDResponse>(
    `query getProject($projectOwnerName: String!, $projectNumber: Int!) {
      ${ownerTypeQuery}(login: $projectOwnerName) {
        projectV2(number: $projectNumber) {
          id
        }
      }
    }`,
    {
      projectOwnerName,
      projectNumber
    }
  )

  const projectId = idResp[ownerTypeQuery]?.projectV2.id
  const contentId = issue?.node_id

  core.debug(`Project node ID: ${projectId}`)
  core.debug(`Content ID: ${contentId}`)

  // Next, use the GraphQL API to add the issue to the project.
  // If the issue has the same owner as the project, we can directly
  // add a project item. Otherwise, we add a draft issue.
  let itemId = undefined
  if (issueOwnerName === projectOwnerName) {
    core.info('Creating project item')

    const addResp = await octokit.graphql<ProjectAddItemResponse>(
      `mutation addIssueToProject($input: AddProjectV2ItemByIdInput!) {
        addProjectV2ItemById(input: $input) {
          item {
            id
          }
        }
      }`,
      {
        input: {
          projectId,
          contentId
        }
      }
    )

    itemId = addResp.addProjectV2ItemById.item.id
    core.setOutput('itemId', itemId)
  } else {
    core.info('Creating draft issue in project')

    const addResp = await octokit.graphql<ProjectV2AddDraftIssueResponse>(
      `mutation addDraftIssueToProject($projectId: ID!, $title: String!) {
        addProjectV2DraftIssue(input: {
          projectId: $projectId,
          title: $title
        }) {
          projectItem {
            id
          }
        }
      }`,
      {
        projectId,
        title: issue?.html_url
      }
    )

    itemId = addResp.addProjectV2DraftIssue.projectItem.id
    core.setOutput('itemId', itemId)
  }

  if (projectId === undefined) {
    throw new Error(`Project ID is undefined: ${idResp[ownerTypeQuery]?.projectV2}. This shouldn't happen.`)
  }
  if (projectOwnerName === undefined) {
    throw new Error(`Project Owner Name is undefined. This shouldn't happen.`)
  }
  await updateStatusFieldValueOnCard(ownerTypeQuery, projectOwnerName, projectNumber, projectId, itemId)
}

export function mustGetOwnerTypeQuery(ownerType?: string): OwnerQueryTypes {
  const ownerTypeQuery = ownerType === 'orgs' ? 'organization' : ownerType === 'users' ? 'user' : null

  if (!ownerTypeQuery) {
    throw new Error(`Unsupported ownerType: ${ownerType}. Must be one of 'orgs' or 'users'`)
  }

  return ownerTypeQuery
}

/**
 * Updates the "Status" field on a project card if an override value has been specified in the action's inputs.
 *
 * If no override value is specified, the field is left unchanged.
 *
 * @param projectOwnerTypeQuery The query type for the owner of the project.
 * @param projectOwnerName
 * @param projectNumber
 * @param projectId
 * @param itemId ID for the newly added card in the project
 * @returns
 */
export async function updateStatusFieldValueOnCard(
  projectOwnerTypeQuery: OwnerQueryTypes,
  projectOwnerName: string,
  projectNumber: number,
  projectId: string,
  itemId: string
): Promise<void> {
  const ghToken = core.getInput('github-token', {required: true})
  const statusFieldOverride = core.getInput('status-override', {required: false})
  core.debug(`Status field override: ${statusFieldOverride}`)

  if (statusFieldOverride.length === 0) {
    core.info('Skipping status field update because no status-override input specified.')
    return
  }

  core.info('Overriding "Status" field value on project item')

  const octokit = github.getOctokit(ghToken)

  const statusFieldIdResp = await octokit.graphql<ProjectV2FieldIDResponse>(
    `query getStatusFieldId($projectOwnerName: String! $projectNumber: Int!) {
        ${projectOwnerTypeQuery}(login: $projectOwnerName) {
            projectV2(number: $projectNumber) {
              field(name: "Status") {
                ... on ProjectV2FieldCommon {
                  id
                }
                ... on ProjectV2SingleSelectField {
                  options {
                    id
                    name
                  }
                }
              }
            }
          }
        }
    `,
    {
      projectOwnerName,
      projectNumber
    }
  )

  const statusFieldId = statusFieldIdResp[projectOwnerTypeQuery]?.projectV2.field.id
  const requiredOptionId = (statusFieldIdResp[projectOwnerTypeQuery]?.projectV2.field.options || []).find(
    option => option.name === statusFieldOverride
  )?.id

  core.debug(`"Status" Field ID: ${statusFieldId}`)
  core.debug(`\`status-override\` value's Single Select Field Option ID: ${requiredOptionId}`)

  if (requiredOptionId === undefined) {
    throw new Error(`Invalid "Status" field option value provided: ${statusFieldOverride}`)
  }

  const updateStatusFieldResp = await octokit.graphql<ProjectV2UpdateItemFieldValueResponse>(
    `
      mutation updateStatusFieldValue($projectId: ID!, $itemId: ID! $fieldId: ID!, $fieldOptionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId, 
          itemId: $itemId,
          fieldId: $fieldId,
          value: {singleSelectOptionId: $fieldOptionId}
        }) {
        projectV2Item {
          updatedAt
        }
      }}
    `,
    {
      projectId,
      itemId,
      fieldId: statusFieldId,
      fieldOptionId: requiredOptionId
    }
  )
}
