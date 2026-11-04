import { done, request, run } from '/opt/blobby/runtime/lib/blobby.mjs'

run(async () => {
  const login = await request('github.login')
  await request('github.password')
  await request('github.otp')
  done({ github: login })
})
