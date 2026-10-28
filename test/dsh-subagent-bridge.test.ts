import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createBridgeKernel, createDshSubagentBridge } from '../src/dsh-subagent-bridge.ts';
import { normalizeTasksEvent } from '../src/events.ts';

const approved = { provider: 'deepseek-official', model: 'deepseek-flash' };
const args = { ...approved, description: 'Check repository', prompt: 'Read the README and report.' };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => {resolve=a;reject=b;}); return { promise, resolve, reject }; };
function fixture(options = {}) {
    let selection = { enabled: true, allowedModels: [approved] };
    const events = new Set();
    const published = [];
    const activations = [];
    const agents = new Map();
    const lifetime = new AbortController();
    const turn = new AbortController();
    const result = deferred();
    let resolveModel = async () => ({ name: 'Flash', reasoning: { efforts: [{ id: 'high' }] } });
    const ctx = {
        get(name) { return name === 'subagentModelSelection' ? { current: () => selection } : name === 'subagents' ? runtime : undefined; },
        llm: { resolveModelInfo: (...values) => resolveModel(...values) },
        agents: { get: id => agents.get(id) },
        on(name, callback) { assert.equal(name, 'session/event');events.add(callback);return () => events.delete(callback); },
    };
    const runtime = {
        getProvider: () => ({ capabilities: { agentPreset: true, agentOptions: true }, inheritsParentContext: false }),
        resolveMaxDepth: () => 1,
        async startActivation(spec) {
            options.startError && (() => { throw options.startError; })();
            const activation = { childId: spec.childId, result: result.promise, disposeCount: 0,
                async dispose() { this.disposeCount++; if (options.cleanupError) throw options.cleanupError; if (options.settleOnDispose) result.resolve({ output: [], stopReason: 'aborted' }); } };
            activations.push({ spec, activation });
            const session = { id: spec.childId, requestHeader: () => ({ config: options.actual ?? spec.request.agentOptions }) };
            agents.set(spec.childId, { session });
            for (const callback of events) callback(session, {});
            return activation;
        },
    };
    const deps = { ctx, parent: { id: 'parent' }, lifetimeSignal: lifetime.signal,
        activeContext: () => ({ signal: turn.signal, cursor: { turn: 7 } }),
        publish: async task => { published.push(structuredClone(task)); },
    };
    return { kernel: createBridgeKernel(deps), deps, published, activations, agents, events, turn, lifetime, result,
        setSelection: value => { selection = value; }, setResolveModel: value => { resolveModel = value; } };
}
async function started(f, promise) {
    // Drain until admission has published. No timers or provider calls are involved.
    for (let i = 0; i < 30 && f.published.length === 0; i++) await Promise.resolve();
    assert.equal(f.published[0]?.status, 'running');
}

test('only authorized routes appear, with adapter-owned efforts', async () => {
    const f=fixture(); const list=await f.kernel.listModels();
    assert.equal(list.enabled,true); assert.equal(list.models.length,1);
    assert.equal(list.models[0].model,approved.model); assert.deepEqual(list.models[0].reasoning.efforts,[{id:'high'}]);
});
test('unauthorized route never starts a child', async () => {
    const f=fixture(); await assert.rejects(f.kernel.delegate({...args,model:'other'}),/not authorized/);
    assert.equal(f.activations.length,0);
});
test('disabled setting does not affect native Agent and rejects bridge delegation', async () => {
    const f=fixture();f.setSelection({enabled:false,allowedModels:[approved]});
    await assert.rejects(f.kernel.delegate(args),/disabled/);
    assert.deepEqual(await f.kernel.guardNative({hook_event_name:'PreToolUse',tool_name:'Agent'}),{});
});
test('native Claude delegation is blocked while DSH selection is enabled; regular tools retain approval behavior',async()=>{
    const f=fixture();
    for(const name of ['Agent','Task','TeamCreate']) assert.equal((await f.kernel.guardNative({hook_event_name:'PreToolUse',tool_name:name})).hookSpecificOutput.permissionDecision,'deny');
    assert.deepEqual(await f.kernel.guardNative({hook_event_name:'PreToolUse',tool_name:'Read'}),{});
});
test('settings revoked during preflight prevent admission',async()=>{
    const f=fixture();f.setResolveModel(async()=>{f.setSelection({enabled:true,allowedModels:[]});return {};});
    await assert.rejects(f.kernel.delegate(args),/not authorized/);assert.equal(f.activations.length,0);
});
test('invalid effort is rejected before any child starts',async()=>{
    const f=fixture();await assert.rejects(f.kernel.delegate({...args,reasoning_effort:'unsupported'}),/reasoning effort/);
    assert.equal(f.activations.length,0);assert.equal(f.events.size,0);
});
test('child uses independent standard preset, exact route, native limits and caller delivery',async()=>{
    const f=fixture();const p=f.kernel.delegate({...args,reasoning_effort:'high'});await started(f,p);
    const {spec}=f.activations[0];
    assert.equal(spec.request.agentPreset,'standard');assert.equal(spec.delivery,'caller');assert.equal(spec.request.parent,f.deps.parent);
    assert.equal(spec.request.maxDepth,1);assert.deepEqual(spec.request.agentOptions,{...approved,reasoningEffort:'high'});
    f.result.resolve({output:[{type:'text',text:'OK'}],stopReason:'completed'});
    const result=await p;assert.equal(result.answer,'OK');assert.equal(result.modelVerified,true);assert.equal(result.model,approved.model);
    assert.equal(f.published.at(-1).actualModel,approved.model);assert.equal(f.published.at(-1).status,'completed');
    assert.equal(f.activations[0].activation.disposeCount,1);assert.equal(f.events.size,0);
});
test('observed route survives DSH unloading the child before the result settles',async()=>{
    const f=fixture();const p=f.kernel.delegate(args);await started(f,p);f.agents.clear();
    f.result.resolve({output:[],stopReason:'completed'});const result=await p;
    assert.equal(result.modelVerified,true);assert.equal(result.model,approved.model);
});
test('a changed actual model is exposed and fails rather than masquerading as the requested model',async()=>{
    const f=fixture({actual:{provider:approved.provider,model:'unexpected'}});const p=f.kernel.delegate(args);await started(f,p);
    f.result.resolve({output:[],stopReason:'completed'});await assert.rejects(p,/differed/);
    assert.equal(f.published.at(-1).actualModel,'unexpected');assert.equal(f.published.at(-1).status,'failed');
});
test('turn cancellation disposes the exact activation and reports stopped',async()=>{
    const f=fixture({settleOnDispose:true});const p=f.kernel.delegate(args);await started(f,p);
    f.turn.abort();await assert.rejects(p);assert.equal(f.activations[0].activation.disposeCount,1);
    assert.equal(f.published.at(-1).status,'stopped');assert.equal(f.events.size,0);
});
test('SDK stop control cancels child and leaves no observer',async()=>{
    const f=fixture({settleOnDispose:true});const p=f.kernel.delegate(args);await started(f,p);
    f.kernel.cancelAll();await assert.rejects(p);assert.equal(f.activations[0].activation.disposeCount,1);assert.equal(f.events.size,0);
});
test('native concurrency rejection is propagated without alternate-provider retry',async()=>{
    const f=fixture({startError:new Error('ACTIVATION_LIMIT_REACHED')});
    await assert.rejects(f.kernel.delegate(args),/ACTIVATION_LIMIT_REACHED/);assert.equal(f.events.size,0);
});
test('task persistence preserves actual versus requested model and does not invent values',()=>{
    const tasks=normalizeTasksEvent([{taskId:'child',description:'read',status:'completed',bridge:true,
        requestedProvider:approved.provider,requestedModel:'requested',actualProvider:approved.provider,actualModel:'observed'}]).tasks;
    assert.equal(tasks[0].actualModel,'observed');assert.equal(tasks[0].requestedModel,'requested');assert.equal(tasks[0].bridge,true);
    assert.equal(normalizeTasksEvent([{taskId:'old',description:'old',status:'completed'}]).tasks[0].actualModel,undefined);
});
test('SDK in-process MCP server can be constructed with the real installed SDK',()=>{
    const f=fixture();const bridge=createDshSubagentBridge(f.deps);assert.equal(bridge.server.type,'sdk');assert.equal(bridge.server.name,'dsh_subagents');
    assert.ok(bridge.server.instance);bridge.server.instance.close();
});

test('real SDK MCP transport advertises tools and enforces whitelist on wire calls', async()=>{
    const f=fixture();const bridge=createDshSubagentBridge(f.deps);
    const awaiting=new Map();const sent=[];
    const transport={
        async start(){},async close(){},
        async send(message){sent.push(message);if(message.id!==undefined)awaiting.get(message.id)?.(message);},
    };
    await bridge.server.instance.connect(transport);
    let sequence=0;
    const call=async(method,params)=>{
        const id=++sequence;const response=new Promise(resolve=>awaiting.set(id,resolve));
        transport.onmessage({jsonrpc:'2.0',id,method,params});
        return response;
    };
    const init=await call('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'dsh-bridge-test',version:'1'}});
    assert.ok(init.result.serverInfo);
    transport.onmessage({jsonrpc:'2.0',method:'notifications/initialized'});
    const list=await call('tools/list',{});assert.deepEqual(list.result.tools.map(x=>x.name),['list_models','delegate']);
    const models=await call('tools/call',{name:'list_models',arguments:{}});
    assert.equal(JSON.parse(models.result.content[0].text).models[0].model,approved.model);
    const denied=await call('tools/call',{name:'delegate',arguments:{...args,model:'not-authorized'}});
    assert.equal(denied.result.isError,true);assert.equal(f.activations.length,0);
    const delegated=call('tools/call',{name:'delegate',arguments:args});
    for(let i=0;i<100&&f.published.length===0;i++)await Promise.resolve();
    assert.equal(f.published[0]?.status,'running');
    f.result.resolve({output:[{type:'text',text:'wire success'}],stopReason:'completed'});
    const reply=await delegated;
    assert.equal(JSON.parse(reply.result.content[0].text).answer,'wire success');
    assert.equal(JSON.parse(reply.result.content[0].text).modelVerified,true);
    await bridge.server.instance.close();
});

test('authorized Claude Code model mounts its own independent Claude preset',async()=>{
    const f=fixture();const route={provider:'claude',model:'sonnet'};
    f.setSelection({enabled:true,allowedModels:[route]});
    assert.equal((await f.kernel.listModels()).models[0].available,true);
    const p=f.kernel.delegate({...args,...route});await started(f,p);
    assert.equal(f.activations[0].spec.request.agentPreset,'claude');
    f.result.resolve({output:[{type:'text',text:'64'}],stopReason:'completed'});
    assert.equal((await p).answer,'64');
});

test('older Hosts without the optional settings service keep native Claude behavior', () => {
  const f = fixture()
  const ctx = { ...f.deps.ctx, get: () => undefined }
  assert.equal(createDshSubagentBridge({ ...f.deps, ctx }), undefined)
})

test('older Hosts without activation support do not install a partial bridge', () => {
  const f = fixture()
  const ctx = { ...f.deps.ctx, get: name => name === 'subagentModelSelection'
    ? { current: () => ({ enabled: true, allowedModels: [approved] }) } : { getProvider: () => ({}) } }
  assert.equal(createDshSubagentBridge({ ...f.deps, ctx }), undefined)
})

test('an unavailable provider is reported without leaking its exception', async () => {
  const f = fixture()
  f.setResolveModel(async () => { throw new Error('private provider diagnostic') })
  const result = await f.kernel.listModels()
  assert.equal(result.models[0].available, false)
  assert.equal(JSON.stringify(result).includes('private provider diagnostic'), false)
})


test('cleanup failure does not leave a successful teammate status', async () => {
  const f = fixture({ cleanupError: new Error('private teardown diagnostic') })
  const pending = f.kernel.delegate(args)
  await started(f, pending)
  f.result.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
  await assert.rejects(pending, /activation cleanup failed/)
  assert.equal(f.published.at(-1).status, 'failed')
  assert.equal(JSON.stringify(f.published).includes('private teardown diagnostic'), false)
})
