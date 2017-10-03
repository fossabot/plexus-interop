/**
 * Copyright 2017 Plexus Interop Deutsche Bank AG
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { UniqueId, Channel, Defaults, ChannelObserver } from "@plexus-interop/transport-common";
import { clientProtocol as plexus, SuccessCompletion, ErrorCompletion, ClientError, ClientProtocolUtils } from "@plexus-interop/protocol";
import { InvocationMetaInfo } from "./InvocationMetaInfo";
import { ClientProtocolHelper as modelHelper, ClientProtocolHelper } from "./ClientProtocolHelper";
import { InvocationState } from "./InvocationState";
import { Observer } from "@plexus-interop/common";
import { Subscription, AnonymousSubscription } from "rxjs/Subscription";
import { StateMaschine, CancellationToken, Logger, LoggerFactory, StateMaschineBase, AsyncHelper } from "@plexus-interop/common";
import { ProvidedMethodReference } from "../api/dto/ProvidedMethodReference";
import { ClientDtoUtils } from "../ClientDtoUtils";

export class GenericInvocation {

    private readonly stateMachine: StateMaschine<InvocationState>;

    private pendingHeader: plexus.interop.protocol.IInvocationMessageHeader | null;

    private id: UniqueId;

    private sentMessagesCounter: number = 0;

    private sendCompletionReceived: boolean = false;

    public readonly readCancellationToken: CancellationToken;

    private sourceChannelSubscription: AnonymousSubscription;

    private metaInfo: InvocationMetaInfo;

    private log: Logger;

    public constructor(
        private readonly sourceChannel: Channel,
        baseReadToken: CancellationToken = new CancellationToken(),
        private readonly invocationTimeout: number = Defaults.OPERATION_TIMEOUT) {
        this.readCancellationToken = new CancellationToken(baseReadToken);
        this.log = LoggerFactory.getLogger("Invocation");
        this.stateMachine = new StateMaschineBase<InvocationState>(InvocationState.CREATED, [
            // initialization states
            {
                from: InvocationState.CREATED, to: InvocationState.START_REQUESTED
            }, {
                from: InvocationState.START_REQUESTED, to: InvocationState.REMOTE_STARTING
            }, {
                from: InvocationState.REMOTE_STARTING, to: InvocationState.OPEN
            }, {
                from: InvocationState.CREATED, to: InvocationState.ACCEPTING_INVOCATION_INFO
            }, {
                from: InvocationState.ACCEPTING_INVOCATION_INFO, to: InvocationState.OPEN
            }, {
                from: InvocationState.START_REQUESTED, to: InvocationState.OPEN
            },
            // active states
            {
                from: InvocationState.OPEN, to: InvocationState.COMPLETION_RECEIVED, preHandler: async () => {
                    this.readCancellationToken.cancel("Invocation close received");
                }
            }, {
                from: InvocationState.COMPLETION_RECEIVED, to: InvocationState.COMPLETED
            }, {
                from: InvocationState.OPEN, to: InvocationState.COMPLETED
            }
        ]);
    }

    public start(metaInfo: InvocationMetaInfo, invocationObserver: ChannelObserver<AnonymousSubscription, ArrayBuffer>): void {
        this.metaInfo = metaInfo;
        this.log.trace("Start basic invocation");
        this.startInvocationInternal(() => this.sendStartInvocationRequest(metaInfo), invocationObserver);
    }

    public startDiscovered(
        methodReference: ProvidedMethodReference,
        invocationObserver: ChannelObserver<AnonymousSubscription, ArrayBuffer>): void {
        this.log.trace("Start discovered invocation");
        this.metaInfo = ClientDtoUtils.providedMethodToInvocationInfo(methodReference);
        this.startInvocationInternal(() => this.sendStartDiscoveredInvocationRequest(methodReference), invocationObserver);
    }

    private startInvocationInternal(sendRequest: () => Promise<void>, invocationObserver: ChannelObserver<AnonymousSubscription, ArrayBuffer>): void {
        this.log.debug("Invocation start requested");
        this.stateMachine.throwIfNot(InvocationState.CREATED);
        this.setUuid(UniqueId.generateNew());
        const subscriptionStartedPromise = this.openSubscription(invocationObserver);
        this.stateMachine.go(InvocationState.START_REQUESTED, {
            preHandler: async () => {
                await subscriptionStartedPromise;
                await sendRequest();
            }
        })
            .catch(e => this.log.error("Invocation start failed", e));
    }

    public acceptInvocation(invocationObserver: ChannelObserver<AnonymousSubscription, ArrayBuffer>): void {
        this.log.debug("Accept of invocation requested");
        this.stateMachine.throwIfNot(InvocationState.CREATED);
        this.stateMachine.go(InvocationState.ACCEPTING_INVOCATION_INFO);
        this.openSubscription(invocationObserver)
            .catch(e => this.log.error("Failed to open channel subscription", e));
    }

    public uuid(): UniqueId {
        return this.id;
    }

    private setUuid(id: UniqueId): void {
        this.log.debug(`Set id, ${id.toString()}`);
        this.log = LoggerFactory.getLogger(`Invocation [${id.toString()}]`);
        this.id = id;
    }

    public getMetaInfo(): InvocationMetaInfo {
        return this.metaInfo;
    }

    private terminate(message: string): void {
        this.log.error("Terminating channel");
        this.closeChannel(new ErrorCompletion(new ClientError(message)));
    }

    public async close(completion: plexus.ICompletion = new SuccessCompletion()): Promise<plexus.ICompletion> {
        this.log.debug("Close invocation requested", JSON.stringify(completion));
        if (this.stateMachine.is(InvocationState.COMPLETED)) {
            this.log.warn("Already completed");
            return Promise.resolve(completion);
        }
        this.stateMachine.throwIfNot(InvocationState.OPEN, InvocationState.COMPLETION_RECEIVED);
        this.stateMachine.go(InvocationState.COMPLETED);
        this.log.trace("Sending send completion message");
        await this.sourceChannel.sendMessage(modelHelper.sendCompletionPayload({}));
        if (ClientProtocolHelper.isSuccessCompletion(completion)) {
            // wait for remote side for success case only
            try {
                this.log.trace("Waiting for send completion from remote");
                await this.waitForIt(() => this.sendCompletionReceived);
            } catch (error) {
                const errorText = "Unable to wait for send completion, trying to terminate";
                this.log.error(errorText, error);
                this.terminate(errorText);
                return Promise.reject(error);
            }
        }
        this.log.trace("Sending channel close message");
        return this.closeChannel(completion);
    }

    private closeChannel(completion: plexus.ICompletion): Promise<plexus.ICompletion> {
        return this.sourceChannel.close(completion).then((channelCompletion) => {
            this.log.debug("Channel closed");
            this.closeInternal();
            const result = ClientProtocolUtils.createSummarizedCompletion(completion, channelCompletion, this.checkInternalStatus());
            this.log.trace(`Completion result ${JSON.stringify(result)}`);
            return result;
        }).catch((e) => {
            this.log.debug("Error during channel closure", e);
            this.closeInternal();
            throw e;
        });
    }

    public async sendMessage(data: ArrayBuffer): Promise<void> {
        this.stateMachine.throwIfNot(InvocationState.OPEN, InvocationState.COMPLETION_RECEIVED);
        this.log.trace(`Sending message of ${data.byteLength} bytes`);
        const headerPayload = modelHelper.messageHeaderPayload({
            length: data.byteLength
        });
        await this.sourceChannel.sendMessage(headerPayload);
        await this.sourceChannel.sendMessage(data);
        this.sentMessagesCounter++;
    }

    public async waitForState(state: InvocationState): Promise<void> {
        this.log.trace(`Waiting for state ${state}`);
        await this.waitForIt(() => this.stateMachine.is(state));
        this.log.trace(`Waiting for state ${state} - DONE`);
    }

    private async waitForIt(check: () => boolean): Promise<void> {
        await AsyncHelper.waitFor(
            check,
            this.readCancellationToken,
            Defaults.STATUS_CHECK_INTERVAL,
            this.invocationTimeout);
    }

    // public methods below are NOT a part of API, for unit tests only

    public currentState(): InvocationState {
        return this.stateMachine.getCurrent();
    }

    public getSentMessagesCounter(): number {
        return this.sentMessagesCounter;
    }

    private handleRemoteSentCompleted(invocationObserver: Observer<ArrayBuffer>): void {
        this.log.debug("Source channel subscription completed");
        this.sendCompletionReceived = true;
        switch (this.stateMachine.getCurrent()) {
            case InvocationState.OPEN:
                this.log.debug("Open state, switching to COMPLETION_RECEIVED");
                this.stateMachine.go(InvocationState.COMPLETION_RECEIVED);
                break;
            case InvocationState.COMPLETED:
                this.log.debug("Already completed");
                break;
            default:
                throw new Error(`Can't handle completion, invalid state ${this.stateMachine.getCurrent()}`);
        }
    }

    private async closeInternal(): Promise<void> {
        this.readCancellationToken.cancel("Invocation closed");
    }

    private openSubscription(
        invocationObserver: ChannelObserver<AnonymousSubscription, ArrayBuffer>): Promise<AnonymousSubscription> {
        this.log.trace(`Starting listening of incoming messages`);
        return new Promise<AnonymousSubscription>((resolve, reject) => {
            this.sourceChannel.open({
                started: (sourceSubscription) => {
                    this.log.debug("Source channel subscription started");
                    this.sourceChannelSubscription = sourceSubscription;
                    resolve(sourceSubscription);
                },
                startFailed: (error) => {
                    this.log.error("Unable to open source channel", error);
                    invocationObserver.startFailed(error);
                    reject(error);
                },
                next: (message) => {
                    try {
                        this.handleIncomingMessage(message, invocationObserver);
                    } catch (e) {
                        this.log.error(`Unknown error`, e);
                        this.terminate("Unknown error");
                        invocationObserver.error(e);
                    }
                },
                complete: () => {
                    this.log.debug("Remote channel closed");
                    invocationObserver.complete();
                },
                error: (e) => {
                    this.log.error("Error from source channel received", e);
                    this.terminate("Error from source channel received");
                    invocationObserver.error(e);
                }
            });
        });

    }

    private handleIncomingMessage(data: ArrayBuffer, invocationObserver: ChannelObserver<AnonymousSubscription, ArrayBuffer>): void {
        this.log.trace(`Received message of ${data.byteLength} bytes`);
        if (this.pendingHeader) {
            this.log.trace(`Received message payload of ${data.byteLength} length`);
            this.pendingHeader = null;
            this.sourceChannel.sendMessage(modelHelper.messageReceivedPayload({
                invocationId: this.uuid()
            }));
            invocationObserver.next(data);
        } else if (this.stateMachine.is(InvocationState.START_REQUESTED)) {
            this.log.debug("Received invocation starting message");
            modelHelper.decodeInvocationStarting(data);
            this.stateMachine.go(InvocationState.REMOTE_STARTING);
        } else if (this.stateMachine.is(InvocationState.REMOTE_STARTING)) {
            this.log.debug("Received invocation started message");
            modelHelper.decodeInvocationStarted(data);
            this.stateMachine.go(InvocationState.OPEN);
            // requested invocation started
            invocationObserver.started(new Subscription(() => this.close()));
        } else if (this.stateMachine.is(InvocationState.ACCEPTING_INVOCATION_INFO)) {
            const envelopObject = modelHelper.decodeBrokerEnvelop(data);
            if (envelopObject.invocationStartRequested) {
                this.log.trace(`Received invocation request message ${JSON.stringify(envelopObject.invocationStartRequested)}`);
                this.metaInfo = ClientProtocolHelper.toInvocationInfo(envelopObject.invocationStartRequested);
                // accepted invocation started
                invocationObserver.started(new Subscription(() => this.close()));
                this.setUuid(UniqueId.generateNew());
                this.stateMachine.go(InvocationState.OPEN);
                this.sourceChannel.sendMessage(modelHelper.invocationStartedMessagePayload({
                    invocationId: this.uuid()
                }));
            } else {
                this.log.warn(`Unknown message received ${JSON.stringify(envelopObject)}`);
            }
        } else if (this.stateMachine.isOneOf(InvocationState.OPEN, InvocationState.COMPLETED)) {
            const envelopObject = modelHelper.decodeInvocationEnvelop(data);
            if (envelopObject.message) {
                this.log.trace(`Received message header`);
                this.pendingHeader = envelopObject.message;
            } else if (envelopObject.confirmation) {
                this.log.trace(`Received message delivery confirmation`);
                this.sentMessagesCounter--;
            } else if (envelopObject.sendCompletion) {
                this.log.trace(`Received send completion`);
                this.handleRemoteSentCompleted(invocationObserver);
            } else {
                this.log.warn(`Unknown message received ${JSON.stringify(envelopObject)}`);
            }
        } else {
            throw new Error(`Unexpected state, ${this.currentState()}`);
        }
    }

    private checkInternalStatus(): plexus.ICompletion {
        if (this.sentMessagesCounter !== 0) {
            const message = `Confirmation not received for all messages, ${this.sentMessagesCounter}`;
            return {
                status: plexus.Completion.Status.Failed,
                error: {
                    message
                }
            };
        } else {
            return {
                status: plexus.Completion.Status.Completed
            };
        }
    }

    private async sendStartInvocationRequest(metaInfo: InvocationMetaInfo): Promise<void> {
        this.log.trace("Sending start request to channel");
        const payload = modelHelper.invocationStartRequestPayload(metaInfo);
        return this.sourceChannel.sendMessage(payload);
    }

    private async sendStartDiscoveredInvocationRequest(methodReference: ProvidedMethodReference): Promise<void> {
        this.log.trace("Sending start discovered request to channel");
        const payload = modelHelper.discoveredInvocationStartRequestPayload(methodReference);
        return this.sourceChannel.sendMessage(payload);
    }
}