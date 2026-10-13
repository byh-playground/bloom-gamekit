/** Configured frequencies share integer divisions; physical RAF/timers may be irregular. */
export function clockRates({baseHz,tickRate,inputHz,renderHz}={}) {
  for(const [name,value] of Object.entries({baseHz,tickRate,inputHz,renderHz})) {
    if(!Number.isSafeInteger(value)||value<=0)throw new RangeError(`${name} must be a positive integer frequency`);
    if(name!=='baseHz'&&baseHz%value!==0)throw new RangeError(`${name} (${value}) must divide baseHz (${baseHz}) exactly`);
  }
  return Object.freeze({baseHz,tickRate,inputHz,renderHz,simulationDivisor:baseHz/tickRate,inputDivisor:baseHz/inputHz,renderDivisor:baseHz/renderHz});
}
