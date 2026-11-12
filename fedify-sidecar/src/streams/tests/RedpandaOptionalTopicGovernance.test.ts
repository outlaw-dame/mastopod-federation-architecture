import { describe, expect, it } from "vitest";
import {
  buildTopicDefinitions,
} from "../redpanda-topic-governance.js";

describe("optional Redpanda topic governance", () => {
  it("does not require disabled Jetstream and notification quarantine topics", () => {
    const topics = buildTopicDefinitions("production");
    const names = topics.map(topic => topic.topic);
    expect(names).toContain("canonical.v1");
    expect(names).not.toContain("at.jetstream.unverified.v1");
    expect(names).not.toContain("canonical.notifications.dlq.v1");
  });
  it("requires the unverified Jetstream topic only when ingress is enabled", () => {
    const topics = buildTopicDefinitions("production", {
      enableUnverifiedJetstream: true,
    });
    const jetstream = topics.find(topic => topic.topic === "at.jetstream.unverified.v1");
    expect(jetstream).toMatchObject({
      partitions:3,replicationFactor:3,
      cleanupPolicy:"delete",retentionMs:24*60*60*1000
    });
    expect(topics.some(topic => topic.topic === "canonical.notifications.dlq.v1"))
      .toBe(false);
  });
  it("requires the private notification DLQ only when enabled", () => {
    const topics = buildTopicDefinitions("production", {
      enableNotificationDlq:true,
    });
    const dlq = topics.find(topic => topic.topic === "canonical.notifications.dlq.v1");
    expect(dlq).toMatchObject({
      partitions:3,replicationFactor:3,
      cleanupPolicy:"delete",retentionMs:7*24*60*60*1000
    });
    expect(topics.some(topic => topic.topic === "at.jetstream.unverified.v1"))
      .toBe(false);
  });
  it("keeps both optional topics disabled on developer profiles unless opted in", () => {
    const base = buildTopicDefinitions("development");
    expect(base.some(topic=>topic.topic==="at.jetstream.unverified.v1")).toBe(false);
    const enabled = buildTopicDefinitions("development", {
      enableUnverifiedJetstream:true,enableNotificationDlq:true
    });
    expect(enabled.filter(topic=>["at.jetstream.unverified.v1","canonical.notifications.dlq.v1"].includes(topic.topic)))
      .toHaveLength(2);
    expect(enabled.find(topic=>topic.topic==="at.jetstream.unverified.v1")?.replicationFactor)
      .toBe(1);
  });
});
