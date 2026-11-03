/** Monaco reads its worker factory from here (set in monacoSetup.ts) */
interface Window {
  MonacoEnvironment?: { getWorker: (workerId: string, label: string) => Worker };
}
