// The Azure resources blobby-sandbox needs for its azure backend: an image registry for the desktop
// disk image, a sandbox group, and the one identity sandboxes run as, which can only pull images.
// Deploy it into a resource group of its own; every name is derived from that group's ID.
//
// ASSUME BREACH: any code in any sandbox of the group can get tokens for the group's identity, so that
// identity gets AcrPull on this registry and nothing else. It never sees secrets: the blobby-sandbox client
// on the user's computer sends a test account straight to the script that asks, sealed in transit.
targetScope = 'resourceGroup'

@description('Region for every resource. Sandbox groups are not in every region.')
param location string = resourceGroup().location

@description('Short prefix for resource names.')
@minLength(2)
@maxLength(10)
param namePrefix string = 'blobby'

@description('Who creates sandboxes and pushes images: the deploying user by default.')
param operatorPrincipalId string = deployer().objectId

@description('Principal type of operatorPrincipalId.')
@allowed(['User', 'Group', 'ServicePrincipal'])
param operatorPrincipalType string = 'User'

var suffix = uniqueString(resourceGroup().id)
var stem = '${namePrefix}-${take(suffix, 6)}'
var tags = {
  application: 'blobby-sandbox'
  managedBy: 'bicep'
}

// Built-in role definitions. Their IDs are the same in every tenant, and public.
var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
  sandboxGroupDataOwner: 'c24cf47c-5077-412d-a19c-45202126392c'
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: '${replace(namePrefix, '-', '')}${suffix}'
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

// The only identity sandboxes can use. It pulls images and nothing else.
resource workloadIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'mi-${stem}-workload'
  location: location
  tags: tags
}

#disable-next-line BCP081
resource sandboxGroup 'Microsoft.App/sandboxGroups@2026-07-01' = {
  name: '${stem}-sbx'
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${workloadIdentity.id}': {}
    }
  }
}

resource workloadPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, workloadIdentity.id, roles.acrPull)
  scope: registry
  properties: {
    principalId: workloadIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPull)
  }
}

resource operatorPush 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, operatorPrincipalId, roles.acrPush)
  scope: registry
  properties: {
    principalId: operatorPrincipalId
    principalType: operatorPrincipalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.acrPush)
  }
}

resource operatorSandboxes 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sandboxGroup.id, operatorPrincipalId, roles.sandboxGroupDataOwner)
  scope: sandboxGroup
  properties: {
    principalId: operatorPrincipalId
    principalType: operatorPrincipalType
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.sandboxGroupDataOwner)
  }
}

output registryName string = registry.name
output registryLoginServer string = registry.properties.loginServer
output sandboxGroupName string = sandboxGroup.name
output location string = location
