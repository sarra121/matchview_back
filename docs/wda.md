Phase 1 (identity) : nrowser sends the auth0 token instead of the shared password, backend verifies it (jose) reads the user id (sub)

Phase 2 (isolation) backend prefixes every storage key with users/id/



Part A http, fetch and the backend 
a request is just four things: a method : get read post put, a url, headers a set of 'name: value' labels carrying metadata 
example authorization: bearer eyiukd, an optional body the data you're sending

a response is three things
a status code 200, headers, a body




fetch is a function that already exists, the runtime (browser and node) provide it globally


const res = await fetch("https://matchview",
    {
        method: "GET",
        headers: { authorization: "Bearer ..."}


    }
)



export interface BackendConfig {
    baseUrl: string 
    secret: string
    fetchImpl?: typeof fetch 

}



export function createBackendClient(config: BackendConfig) {

    const baseUrl = config.baseUrl.replace(/\/+$/, '')
    const doFetch = config.fetchImpl    ?? fetch

    async function request<T>(path: string)






}