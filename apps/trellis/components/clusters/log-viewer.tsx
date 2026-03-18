"use client";

import { useEffect, useState, useRef } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { createClient } from "@/lib/supabase/client";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Terminal, Loader2, Play, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface LogViewerProps {
  clusterId: string | null;
  clusterName?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface LogEntry {
  id: number;
  created_at: string;
  log_chunk: string;
  stream_type: string;
}

export function LogViewer({ clusterId, clusterName, open, onOpenChange }: LogViewerProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSimulating, setIsSimulating] = useState(false);
  const [provisionId, setProvisionId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const supabase = createClient();
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch latest provision and logs when opened
  useEffect(() => {
    if (open && clusterId) {
      fetchLatestProvision();
    } else {
      setLogs([]);
      setProvisionId(null);
    }
  }, [open, clusterId]);

  // Subscribe to new logs when we have a provisionId
  useEffect(() => {
    if (!provisionId) return;

    const channel = supabase
      .channel(`provision_logs:${provisionId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "provision_logs",
          filter: `provision_id=eq.${provisionId}`,
        },
        (payload) => {
          const newLog = payload.new as LogEntry;
          setLogs((prev) => [...prev, newLog]);
          // Auto-scroll to bottom
          setTimeout(() => {
            bottomRef.current?.scrollIntoView({ behavior: "smooth" });
          }, 100);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [provisionId, supabase]);

  const fetchLatestProvision = async () => {
    if (!clusterId) return;
    setIsLoading(true);
    
    try {
      // Get the most recent provision for this cluster
      const { data: provisions, error } = await supabase
        .from("provisions")
        .select("id, status, created_at")
        .eq("cluster_id", clusterId)
        .order("created_at", { ascending: false })
        .limit(1);

      if (error) throw error;

      if (provisions && provisions.length > 0) {
        const latestProvision = provisions[0];
        setProvisionId(latestProvision.id);

        // Fetch existing logs for this provision
        const { data: existingLogs, error: logsError } = await supabase
          .from("provision_logs")
          .select("*")
          .eq("provision_id", latestProvision.id)
          .order("id", { ascending: true });

        if (logsError) throw logsError;
        setLogs(existingLogs as LogEntry[]);
      } else {
        setProvisionId(null);
        setLogs([]);
      }
    } catch (error) {
      console.error("Error fetching logs:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const simulateProvisioning = async () => {
    if (!clusterId) return;
    setIsSimulating(true);

    try {
      // 1. Create a new provision
      const { data: newProvision, error: provError } = await supabase
        .from("provisions")
        .insert({
          cluster_id: clusterId,
          config_snapshot: { simulated: true, timestamp: new Date().toISOString() },
          status: "QUEUED",
        })
        .select()
        .single();

      if (provError) throw provError;

      if (!newProvision) {
        throw new Error("Failed to create provision: No data returned");
      }

      setProvisionId(newProvision.id);
      setLogs([]); // Clear previous logs
      
      // 2. Stream fake logs
      const steps = [
        "Initializing Grape CLI v1.2.0...",
        "Loading configuration...",
        "Validating cloud credentials for AWS...",
        "Credentials validated successfully.",
        "Checking VPC configuration...",
        "VPC 'grape-vpc-dev' found (subnet-12345678).",
        "Provisioning Kubernetes cluster (EKS)...",
        "Creating control plane...",
        "Waiting for control plane to become active...",
        "Control plane active.",
        "Creating node group 'worker-group-1'...",
        "Instances launching: i-0abcdef1234567890",
        "Instances launching: i-0abcdef0987654321",
        "Waiting for nodes to join cluster...",
        "Nodes joined: 2/2 ready.",
        "Installing core addons (vpc-cni, kube-proxy, coredns)...",
        "Installing Tendril agent...",
        "Tendril agent connected.",
        "Cluster 'grape-dev' is ready!",
        "Done in 245s."
      ];

      for (const step of steps) {
        if (!open) break; // Stop if closed

        await new Promise((resolve) => setTimeout(resolve, Math.random() * 800 + 400));

        const logEntry: LogEntry = {
          id: Date.now(),
          created_at: new Date().toISOString(),
          log_chunk: step,
          stream_type: "stdout"
        };

        // Optimistic update
        setLogs((prev) => [...prev, logEntry]);

        // Scroll to bottom
        setTimeout(() => {
           bottomRef.current?.scrollIntoView({ behavior: "smooth" });
        }, 50);

        const { error: logError } = await supabase.from("provision_logs").insert({
          provision_id: newProvision.id,
          log_chunk: step,
          stream_type: "stdout"
        });

        if (logError) {
           console.error("Failed to insert log chunk:", logError);
        }
      }

    } catch (error) {
      console.error("Simulation error:", error);
    } finally {
      setIsSimulating(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-3xl flex flex-col h-full bg-slate-950 border-l-slate-800 text-slate-100 p-0 gap-0">
        <SheetHeader className="p-6 border-b border-slate-800 bg-slate-900/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-indigo-500/10 rounded-lg">
                <Terminal className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <SheetTitle className="text-slate-100">Provisioning Logs</SheetTitle>
                <SheetDescription className="text-slate-400">
                  Real-time activity for {clusterName || "Cluster"}
                </SheetDescription>
              </div>
            </div>
            <div className="flex gap-2">
               <Button 
                size="sm" 
                variant="outline" 
                className="border-slate-700 bg-slate-800 hover:bg-slate-700 text-slate-300"
                onClick={fetchLatestProvision}
                disabled={isLoading || isSimulating}
              >
                <RefreshCw className={`w-3.5 h-3.5 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh
              </Button>
              <Button 
                size="sm" 
                variant="default"
                className="bg-indigo-600 hover:bg-indigo-700 text-white border-none"
                onClick={simulateProvisioning}
                disabled={isSimulating}
              >
                {isSimulating ? (
                  <Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" />
                ) : (
                  <Play className="w-3.5 h-3.5 mr-2" />
                )}
                Simulate
              </Button>
            </div>
          </div>
        </SheetHeader>
        
        <div className="flex-1 overflow-hidden relative font-mono text-sm">
          <ScrollArea className="h-full w-full p-6">
            {!provisionId && !isLoading && logs.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-slate-500 py-20">
                <Terminal className="w-12 h-12 mb-4 opacity-20" />
                <p>No provisioning logs found.</p>
                <p className="text-xs mt-2">Click "Simulate" to generate test data.</p>
              </div>
            ) : (
              <div className="space-y-1.5 pb-10">
                {logs.map((log, i) => (
                  <div key={log.id || i} className="flex gap-3 group animate-in fade-in duration-300">
                    <span className="text-slate-600 select-none shrink-0 w-8 text-right text-xs pt-0.5">
                      {i + 1}
                    </span>
                    <span className="text-slate-500 select-none shrink-0 text-xs pt-0.5 w-[85px]">
                       {new Date(log.created_at || Date.now()).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute:'2-digit', second:'2-digit' })}
                    </span>
                    <span className={`break-all ${log.stream_type === 'stderr' ? 'text-red-400' : 'text-slate-300'}`}>
                      {log.log_chunk}
                    </span>
                  </div>
                ))}
                <div ref={bottomRef} />
                {isSimulating && (
                  <div className="flex gap-3 mt-2 animate-pulse">
                    <span className="w-8" />
                    <span className="w-[85px]" />
                    <span className="w-2 h-4 bg-indigo-500/50 block" />
                  </div>
                )}
              </div>
            )}
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}
