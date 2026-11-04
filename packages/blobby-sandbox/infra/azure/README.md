# Azure resources

[`main.bicep`](main.bicep) creates what the `azure` backend needs, in a resource group of its own:

| Resource | What for |
|---|---|
| Container registry (Basic) | Not used yet: the `azure` backend builds its disk images from public container images, such as `ubuntu:24.04`. It's here for a desktop image of your own |
| Sandbox group | Where sandboxes run |
| User-assigned identity | The only identity sandboxes run as. It gets `AcrPull` on the registry and nothing else |
| Role assignments | `AcrPull` for that identity; `AcrPush` and **Container Apps SandboxGroup Data Owner** for the operator |

Every name is derived from the resource group's ID, so nothing account-specific is in this folder. The
operator is whoever deploys it (`deployer()`), unless `operatorPrincipalId` says otherwise.

> **Assume breach.** Any code in any sandbox of the group can get tokens for the group's identity, so that
> identity can only pull images. It never sees secrets: when a script asks for a test account, the
> `blobby-sandbox` client on your computer sends it straight to that script, sealed in transit. The script,
> and so the sandbox, does get the username, password, and a current 2FA code.

## Deploy

Pick a region that has sandbox groups (`az provider show -n Microsoft.App --query
"resourceTypes[?resourceType=='sandboxGroups'].locations"`), then, with `az` signed in to the
subscription:

```sh
az group create -n <resource group> -l <region>
az deployment group create -g <resource group> -n blobby-sandbox -f infra/azure/main.bicep --validation-level Template
```

`--validation-level Template` skips the sandbox group's provider preflight, which rejects this definition
without saying why; the deployment itself succeeds. `what-if` needs the same flag.

## Point blobby-sandbox at it

Keep the result in `~/.config/blobby/azure.json`, readable only by you, never in a repository:

```json
{
  "subscription": "00000000-0000-0000-0000-000000000000",
  "resourceGroup": "<resource group>",
  "sandboxGroup": "<the deployment's sandboxGroupName output>",
  "location": "<region>"
}
```

`az deployment group show -g <resource group> -n blobby-sandbox --query properties.outputs` prints the
outputs again.
