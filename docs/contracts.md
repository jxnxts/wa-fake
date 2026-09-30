# Shared contracts

Relative `.ts` imports are used during development; the build bundles CLI/SDK and embeds inspector assets.

GET `/health`: `{status:"ok",mode:"synthetic-only"}`. Graph bearer: `wa-fake-token`; Sim bearer: `wa-fake-sim`. EventSource: `/_wa/events?token=wa-fake-sim` with a synthetic token.

GET `/_wa/state`: `{now,users,phones,messages,templates,flows,sessions,media,webhooks,logs}`; public collections are arrays.

Webhook configuration performs a real loopback GET with `hub.mode=subscribe`, the configured `hub.verify_token`, and a numeric `hub.challenge`. The callback must return HTTP 200 with that exact challenge as its response body. Failed verification leaves the callback configuration unchanged.

- Message: `{id,direction:"inbound"|"outbound",from,to,phone_number_id,type,timestamp,status,payload,render?}`; payload is original synthetic wire data.
- Persona: `{wa_id,name,exists,blocked,marketing_opt_out}`.
- Phone: `{id,waba_id,display_phone_number,registered,public_key?}`.

## Sim endpoints

| Method/path                              | Request/result                                             |
| ---------------------------------------- | ---------------------------------------------------------- | ---------- | -------- | ------------ |
| POST `/_wa/users`                        | `{wa_id,name?,exists?,blocked?,marketing_opt_out?}`        |
| POST `/_wa/users/:id/send`               | `{phone_number_id?,type,...wire}`                          |
| POST `/_wa/users/:id/tap`                | `{message_id,button_id}`                                   |
| POST `/_wa/users/:id/select`             | `{message_id,row_id}`                                      |
| POST `/_wa/users/:id/react`              | `{message_id,emoji}`                                       |
| GET `/_wa/outbox?to=&type=&since=&wait=` | `{messages:[...]}`; bounded long-poll                      |
| POST `/_wa/clock`                        | `{advance:"1h"}` or milliseconds                           |
| POST `/_wa/faults`                       | `{match:{path,to,type},times,error:{code},phase?}`         |
| GET `/_wa/log`                           | Redacted evidence                                          |
| POST `/_wa/reset`                        | Reset synthetic state                                      |
| POST `/_wa/snapshot`                     | Serializable snapshot                                      |
| POST `/_wa/restore`                      | `{snapshot}`                                               |
| POST `/_wa/webhooks/:id/redeliver`       | Replay event                                               |
| POST `/_wa/webhooks/drain`               | `{advance?:true,limit?}`                                   |
| POST `/_wa/config`                       | `{webhook_url,verify_token?,app_secret?}`; local handshake |
| POST `/_wa/templates/:id/review`         | `{status:"APPROVED"                                        | "REJECTED" | "PAUSED" | "DISABLED"}` |

## Flow sessions

POST `/_wa/users/:id/flows/open {message_id,flow_id?,flow_token?}` returns `{id,screen,data,flow,complete,fields,render,renderedScreen?,values,errors,status,result?,nfm_reply?}`. Internal tokens/runtime state are excluded from the projection.

`fill {data}` fills visible fields. `submit {data?,action?}` dispatches Footer or an eligible rendered action. Screen data/action literals are resolved by the runtime and are not form fields. `back {}` follows history and declared endpoint refresh. GET `/_wa/flows/:id/preview` returns a preview; Graph preview points to `/?flow=<id>`.

## Extensions

`createTemplates(engine)`/`createFlows(engine)` return `GraphExtension`: async `graph(ctx)`, `sim(ctx)`, optional `validateMessage(payload,phone)`. `EngineHost` provides store/config, `now()` milliseconds, `id`, `emit`, `enqueueWebhook`, `receiveMessage`, `graphError`, `assertLocalUrl`. Extensions do not own servers or real credentials.
