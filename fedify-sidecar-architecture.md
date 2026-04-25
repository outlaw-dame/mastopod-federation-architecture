# ActivityPods Fedify Sidecar Architecture

**Author:** Manus AI

**Date:** January 3, 2026

## 1. Introduction

This document proposes a new architecture for the Mastopod application, a fork of ActivityPods, to address existing backend issues, performance bottlenecks, and missing features. The core of this proposal is the introduction of a **Fedify sidecar** to handle all federation-related tasks, providing native, high-performance support for both **ActivityPub** and **ATProto**. The goal is to minimize changes to the core ActivityPods codebase while enabling seamless cross-protocol federation.

### 1.1. The Problem

Our analysis of the current Mastopod and ActivityPods architecture has identified several key issues:

*   **Performance Bottlenecks:** The synchronous processing of activities, especially for users with large inboxes, leads to long response times and a poor user experience. The lack of a shared inbox results in a high volume of redundant requests, further straining server resources.
*   **Scalability Limitations:** The current architecture is not well-suited for scaling to a large number of users or high levels of activity. The reliance on direct, synchronous processing of activities is a major limiting factor.
*   **Federation Compatibility Issues:** Mastopod has known compatibility issues with several popular Fediverse platforms, including Pixelfed, Castopod, and WriteFreely. These issues stem from a variety of factors, including differing interpretations of the ActivityPub specification and authentication problems.
*   **Missing Features:** The current implementation lacks several features that are standard in other Fediverse applications, such as robust federation settings, blocking capabilities, and efficient content delivery.

### 1.2. The Solution: A Fedify Sidecar

To address these challenges, we propose the implementation of a Fedify sidecar. Fedify is a modern, robust, and highly-performant TypeScript framework for building ActivityPub-compatible servers. By offloading all federation logic to a dedicated sidecar, we can:

*   **Decouple Federation from Core Logic:** The ActivityPods core can focus on its primary responsibilities of data storage, business logic, and application-specific features, while the Fedify sidecar handles the complexities of federation.
*   **Improve Performance and Scalability:** The sidecar will leverage a message queue for asynchronous processing of activities, eliminating performance bottlenecks and enabling the system to scale horizontally.
*   **Enhance Compatibility:** Fedify is designed with a strong emphasis on compatibility and interoperability, which will help resolve the existing issues with other Fediverse platforms.
*   **Implement Missing Features:** The sidecar architecture makes it easier to implement missing features like advanced federation controls, content filtering, and optimized content delivery.

## 2. Proposed Architecture

The proposed architecture introduces a Fedify sidecar that sits between the ActivityPods core and the rest of the Fediverse. All inbound and outbound federation traffic will be routed through the sidecar.

### 2.1. Architecture Diagram

```mermaid
graph TD
    subgraph "ActivityPods Pod"
        A[ActivityPods Core] -->|1. Post to Outbox| B(PodOutboxService)
        B -->|2. Publish to Stream| C{Stream1 (Redis Pub/Sub)}
        D[Fedify Sidecar] -->|6. Forward to Inbox| E(PodInboxService)
        E -->|7. Persist to Fuseki| F[Jena Fuseki]
    end

    subgraph "Federation Layer"
        C -->|3. Consume| D
        D -->|4a. ActivityPub| G[Fediverse Inboxes]
        D -->|4b. ATProto| I[ATProto Relays/PDS]
        H[Remote AP Servers] -->|5a. Inbound| D
        J[ATProto Firehose] -->|5b. Inbound| D
    end

    style A fill:#cde4ff
    style B fill:#cde4ff
    style E fill:#cde4ff
    style F fill:#cde4ff
    style C fill:#ffe4b5
    style D fill:#d4edda
    style G fill:#f8d7da
    style H fill:#f8d7da
```

### 2.2. Component Descriptions

*   **ActivityPods Core:** The core ActivityPods application will continue to be responsible for user authentication, data storage (in Jena Fuseki), and application-specific logic. However, it will no longer be directly involved in federation.
*   **PodOutboxService:** When a user creates a new post, the `PodOutboxService` will save the activity to the user's outbox in Fuseki and then publish the activity to a Redis Pub/Sub channel (Stream1).
*   **Stream1 (Redis Pub/Sub):** This will serve as a lightweight, real-time message bus for decoupling the ActivityPods core from the Fedify sidecar. All new activities from the pod will be published to this stream.
*   **Fedify Sidecar:** This is the new component that will handle all federation logic. It will:
    *   Consume activities from Stream1.
    *   Use a persistent message queue (e.g., Redis-backed BullMQ) for durable, asynchronous delivery of activities to remote servers.
    *   Handle all HTTP signature creation and verification.
    *   Receive inbound activities from remote servers, verify them, and then forward them to the `PodInboxService`.
    *   Implement per-domain rate limiting and retry policies for outbound delivery.
*   **PodInboxService:** This service will receive verified activities from the Fedify sidecar and persist them to the user's inbox in Fuseki.
*   **Jena Fuseki:** The primary RDF datastore for all pod data, including user profiles, activities, and collections.

## 3. Data Flows

### 3.1. Outbound Federation

1.  A user creates a new post in the Mastopod application.
2.  The `PodOutboxService` in the ActivityPods core saves the activity to the user's outbox in Jena Fuseki.
3.  The `PodOutboxService` publishes the activity to the `Stream1` Redis Pub/Sub channel.
4.  The Fedify sidecar, which is subscribed to `Stream1`, receives the activity.
5.  The sidecar enqueues the activity in its outbound message queue for delivery to the appropriate remote inboxes.
6.  The sidecar's queue processor picks up the activity, signs it with the user's private key, and delivers it to the remote inboxes.

### 3.2. Inbound Federation

1.  A remote server sends an activity to a user's inbox on the pod.
2.  The request is intercepted by the Fedify sidecar.
3.  The sidecar verifies the HTTP signature and performs any other necessary validation.
4.  If the activity is valid, the sidecar forwards it to the `PodInboxService` in the ActivityPods core.
5.  The `PodInboxService` persists the activity to the user's inbox in Jena Fuseki.

## 4. Implementation Plan

1.  **Set up the Fedify Sidecar:**
    *   Create a new Node.js project for the sidecar.
    *   Install Fedify and its dependencies.
    *   Configure the sidecar to connect to the existing Redis instance.
2.  **Modify the `PodOutboxService`:**
    *   Add logic to publish new activities to the `Stream1` Redis Pub/Sub channel.
3.  **Implement the Fedify Sidecar Logic:**
    *   Create a consumer to listen for new activities on `Stream1`.
    *   Implement the outbound delivery logic using Fedify's message queue and delivery features.
    *   Implement the inbound activity handling logic, including signature verification and forwarding to the `PodInboxService`.
4.  **Configure Routing:**
    *   Update the reverse proxy (e.g., Traefik) to route all federation-related traffic to the Fedify sidecar.
5.  **Testing and Deployment:**
    *   Thoroughly test the new architecture in a staging environment.
    *   Deploy the Fedify sidecar alongside the existing ActivityPods infrastructure.

## 5. Conclusion

The proposed Fedify sidecar architecture offers a clear path to resolving the performance, scalability, and compatibility issues currently facing the Mastopod application. By decoupling federation from the core application logic, we can leverage the power and flexibility of the Fedify framework to build a more robust, reliable, and feature-rich Fediverse experience for our users, all while minimizing the impact on the existing ActivityPods codebase.

## 6. References

[1] Fedify Documentation. (n.d.). Retrieved from https://fedify.dev/

[2] ActivityPods Documentation. (n.d.). Retrieved from https://docs.activitypods.org/

[3] Mastopod GitHub Repository. (n.d.). Retrieved from https://github.com/activitypods/mastopod
