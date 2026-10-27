/** Keep the native driver's process-local turn reservation aligned with external history. */
export function alignIdleAgent(agent,events){
 if(agent.status!=='idle'||agent.phase?.kind!=='idle'||typeof agent.setPhase!=='function')throw Error('AGENT_NOT_SAFELY_IDLE');
 const lastTurn=events.reduce((n,e)=>e.type==='turn/start'?Math.max(n,e.data.turn):n,0);
 if(agent.phase.lastTurn>lastTurn)throw Error('AGENT_AHEAD_OF_HISTORY');
 if(agent.phase.lastTurn!==lastTurn)agent.setPhase({...agent.phase,lastTurn});
 return lastTurn;
}
