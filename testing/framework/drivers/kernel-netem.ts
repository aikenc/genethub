import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

/** The worker adapter must create an isolated namespace before any product process starts. */
export function startKernelNetem(port: number) {
  const namespace = readlinkSync("/proc/self/ns/net");
  if (!process.env.TESTCTL_PARENT_NETNS || namespace === process.env.TESTCTL_PARENT_NETNS) throw new Error("netem requires an independently created worker network namespace");
  const tc = process.env.GENEHUB_TEST_TC;
  if (!tc?.startsWith("/") || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("declared tc executable or Relay port missing");
  const run = (...args: string[]) => execFileSync(tc,args,{encoding:"utf8",timeout:5000,maxBuffer:128*1024});
  const tcp = () => {
    const lines=readFileSync("/proc/net/snmp","utf8").split("\n").filter(line=>line.startsWith("Tcp:"));
    const names=lines[0]?.trim().split(/\s+/).slice(1)??[],values=lines[1]?.trim().split(/\s+/).slice(1)??[];
    return Object.fromEntries(names.map((key,i)=>[key,Number(values[i]??0)]));
  };
  const before=tcp();
  let active=false;
  const stats=()=>{
    const text=run("-s","qdisc","show","dev","lo");
    const section=text.split("qdisc ").find(part=>part.startsWith("netem 30:"))??"";
    const sent=/Sent (\d+) bytes (\d+) pkt \(dropped (\d+)/.exec(section);
    const current=tcp();
    return {active,bytes:Number(sent?.[1]??0),packets:Number(sent?.[2]??0),dropped:Number(sent?.[3]??0),backlog:/backlog\s+(\S+\s+\S+)/.exec(section)?.[1]??null,retransmits:(current.RetransSegs??0)-(before.RetransSegs??0),outSegments:(current.OutSegs??0)-(before.OutSegs??0)};
  };
  const setLoss=(loss:number)=>run("qdisc","change","dev","lo","parent","1:3","handle","30:","netem","limit","10000","delay","80ms","20ms","loss",`${loss}%`,"rate","5mbit");
  try {
    run("qdisc","add","dev","lo","root","handle","1:","prio","bands","3","priomap",...Array(16).fill("0"));active=true;
    run("qdisc","add","dev","lo","parent","1:3","handle","30:","netem","limit","10000","delay","80ms","20ms","loss","1%","rate","5mbit");
    for(const direction of ["sport","dport"])run("filter","add","dev","lo","protocol","ip","parent","1:","prio","1","u32","match","ip",direction,String(port),"0xffff","flowid","1:3");
  } catch(error){if(active)run("qdisc","del","dev","lo","root");throw error;}
  return {stats,setLoss,
    // New packets bypass impairment; queued packets keep draining. Deleting
    // the qdisc here would inject an extra, unmeasured burst of packet loss.
    restore(){if(active)run("filter","del","dev","lo","parent","1:");},
    stop(){if(active){run("qdisc","del","dev","lo","root");active=false;}}};
}
