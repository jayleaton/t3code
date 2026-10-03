/** Command Code headless owns stdin for one turn and cannot accept a second prompt mid-run. */
export function supportsProviderTurnSteering(driver: string | null | undefined): boolean {
  return driver !== "commandcode";
}
