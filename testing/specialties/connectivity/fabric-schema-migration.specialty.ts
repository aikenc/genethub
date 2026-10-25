import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defineSpecialty, startHub, enrollCatalogSource, type HubHandle } from "../../framework/public.ts";

defineSpecialty({
  id:"specialty.fabric-pool.public-schema-migration",title:"Real public enrollment, Control artifact reopen and independent SQLite migration/rollback facts",
  oracle:"A real legacy node row keeps its handle after service restart upgrades its schema; public HTTP admits a second lane; the old single-lane index rejects both active lanes until explicit secondary revocation, while primary/foreign keys remain valid; public directory preserves literal and raw-key identities",
  catches:["additive migration loses old node", "old binary rollback cannot open new active rows", "native fingerprint is rehashed", "test bypasses public enrollment/admission"],
  tags:["fabric-pool","migration","contract"],llm:{default:"none"},requiredRepos:["cloud"],
  requirements:[{kind:"python",env:"GENEHUB_PYTHON",minVersion:[3,7],modules:[]}],
  resources:{environments:1,cpu:2,memoryMb:1024,io:1,browser:0},expectedDurationMs:20000,timeoutMs:90000,
  surfaces:["cloud-server","hub-http","sqlite"],productInterfaces:["hub-http"],
},async t=>{
  const databasePath=join(t.env.root,"lane-migration.sqlite");
  const config={databasePath,relayOrigin:"http://127.0.0.1:9",relayToken:"isolated-schema-contract"};
  let hub:HubHandle|undefined;
  const stop=async()=>{const current=hub;hub=undefined;await current?.stop();};
  const sql=async(mode:string,machine:string)=>{
    const script=`import sqlite3,json,sys,datetime
p,mode,machine=sys.argv[1:]
c=sqlite3.connect(p);c.execute('PRAGMA foreign_keys=ON')
old="CREATE UNIQUE INDEX idx_fabric_endpoints_machine ON fabric_endpoints(machine_id) WHERE machine_id IS NOT NULL AND revoked_at IS NULL"
primary=c.execute('SELECT handle FROM fabric_endpoints WHERE machine_id=? AND revoked_at IS NULL AND lane=0',(machine,)).fetchone()[0]
rejected=False
if mode=='legacy':
 c.execute('DROP INDEX idx_fabric_endpoints_machine');c.execute('ALTER TABLE fabric_endpoints DROP COLUMN lane');c.execute(old);c.commit()
elif mode=='rollback':
 try:
  c.execute('BEGIN');c.execute('DROP INDEX idx_fabric_endpoints_machine');c.execute(old);c.commit()
 except sqlite3.IntegrityError:
  rejected=True;c.rollback()
 if not rejected:raise RuntimeError('old index unexpectedly accepted two lanes')
 stamp=datetime.datetime.now(datetime.timezone.utc).isoformat()
 c.execute('BEGIN');c.execute('UPDATE fabric_route_tickets SET revoked_at=? WHERE target_endpoint_handle IN (SELECT handle FROM fabric_endpoints WHERE lane=1) AND revoked_at IS NULL',(stamp,));c.execute('UPDATE fabric_endpoints SET revoked_at=? WHERE lane=1 AND revoked_at IS NULL',(stamp,));c.execute('DROP INDEX idx_fabric_endpoints_machine');c.execute(old);c.commit()
rows=c.execute('SELECT handle FROM fabric_endpoints WHERE machine_id=? AND revoked_at IS NULL',(machine,)).fetchall()
print(json.dumps({'primary':primary,'active':[r[0] for r in rows],'oldIndexRejected':rejected,'foreignKeyViolations':len(c.execute('PRAGMA foreign_key_check').fetchall())}))
c.close()`;
    const {stdout}=await promisify(execFile)(process.env.GENEHUB_PYTHON!,["-c",script,databasePath,mode,machine],{timeout:10000,maxBuffer:8192});
    return JSON.parse(stdout) as {primary:string;active:string[];oldIndexRejected:boolean;foreignKeyViolations:number};
  };
  try{
    hub=await startHub(config);const owner=hub.browser();await hub.signInOwner(owner);
    const node=await enrollCatalogSource(hub,owner,"Migration node");await node.admission(0);
    const literal=await enrollCatalogSource(hub,owner,"Literal fingerprint",{publicKey:"abcd-0123-4567-89ef"});
    const bytes=Buffer.from("actual public key bytes"),raw=await enrollCatalogSource(hub,owner,"Raw public key",{publicKey:bytes.toString("base64")});
    const directory=await owner.json<{machines:Array<{id:string;fingerprint:string}>}>("/app/machines");
    const expected=createHash("sha256").update(bytes).digest("hex").slice(0,16).toUpperCase().match(/.{4}/g)!.join("-");
    t.assertions.assert(directory.machines.find(m=>m.id===literal.machineId)?.fingerprint==="ABCD-0123-4567-89EF"&&directory.machines.find(m=>m.id===raw.machineId)?.fingerprint===expected,"public directory changed native/raw-key identity semantics");
    await stop();const legacy=await sql("legacy",node.machineId);
    hub=await startHub(config);await node.admission(1,hub);const upgraded=await sql("inspect",node.machineId);
    t.assertions.assert(upgraded.primary===legacy.primary&&upgraded.active.length===2,"actual service upgrade/public admission lost the legacy primary or second lane");
    await stop();const rollback=await sql("rollback",node.machineId);
    t.assertions.assert(rollback.oldIndexRejected&&rollback.active.length===1&&rollback.active[0]===legacy.primary&&rollback.foreignKeyViolations===0,"old-index rollback precondition or primary preservation failed");
    hub=await startHub(config);await node.admission(1,hub);const resumed=await sql("inspect",node.machineId);
    t.assertions.assert(resumed.primary===legacy.primary&&resumed.active.length===2&&resumed.foreignKeyViolations===0,"reopening after rollback did not restore lane-aware admission");
    t.note(JSON.stringify({publicEnrollments:3,artifactReopens:3,legacyHandlePreserved:true,oldIndexRejectedBeforeRevocation:true,rollbackPrimaryPreserved:true,foreignKeyViolations:0,literalAndRawIdentity:true}));
  }finally{await stop();}
});
