/**
 * Copyright 2017-2020 Plexus Interop Deutsche Bank AG
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
namespace Plexus.Interop.Transport.Transmission.WebSockets.Server.Internal
{
    using global::Fleck;
    using Plexus.Channels;
    using Plexus.Processes;
    using System;
    using System.IO;
    using System.Net;
    using System.Threading.Tasks;

    internal sealed class WebSocketTransmissionServer : ProcessBase, ITransmissionServer
    {
        private const int AcceptedConnectionsBufferSize = 20;
        private const string ServerName = "ws-v1";
        private readonly WebSocketTransmissionServerOptions _options;
        private WebSocketServer _server;

        private readonly IChannel<ITransmissionConnection> _buffer = new BufferedChannel<ITransmissionConnection>(AcceptedConnectionsBufferSize);
        private readonly IServerStateWriter _stateWriter;

        public WebSocketTransmissionServer(WebSocketTransmissionServerOptions options)
        {
            _options = options;
            _stateWriter = new ServerStateWriter(ServerName, _options.WorkingDir);
            _buffer.Out.PropagateCompletionFrom(Completion);
        }

        public IReadableChannel<ITransmissionConnection> In => _buffer.In;

        protected override async Task<Task> StartCoreAsync()
        {
            FleckLog.Level = LogLevel.Debug;
            FleckLog.LogAction = (lvl, msg, exc) =>
            {
                Log.Debug(exc, msg);
            };
            using (_stateWriter)
            using (_server = CreateWebSocketServerWithRetry(_options.Port))
            {
                var address = "ws://" + _server.ListenerSocket.LocalEndPoint;                
                _stateWriter.Write("address", address);
                _stateWriter.SignalInitialized();
                SetStartCompleted();
                Log.Info("WebSocket server started on {0}", address);
                await CancellationToken.ToAwaitable().AsTask().IgnoreAnyCancellation().ConfigureAwait(false);
            }
            return TaskConstants.Completed;
        }

        private WebSocketServer CreateWebSocketServerWithRetry(uint port)
        {
            var server = StartWebSocketServer($"ws://127.0.0.1:{port}", true);
            server = server ?? StartWebSocketServer($"ws://127.0.0.1:{port}", false);
            server = server ?? StartWebSocketServer($"ws://localhost:{port}", true);
            server = server ?? StartWebSocketServer($"ws://localhost:{port}", false);
            server = server ?? StartWebSocketServer($"ws://[::1]:{port}", true);
            server = server ?? StartWebSocketServer($"ws://[::1]:{port}", false);
            if (server == null)
            {
                throw new InvalidOperationException("Failed to start websocket server");
            }
            return server;
        }

        private WebSocketServer StartWebSocketServer(string url, bool supportDualStack)
        {
            var server = new WebSocketServer(url, supportDualStack);
            try
            {
                server.RestartAfterListenError = true;
                server.ListenerSocket.NoDelay = true;
                server.Start(OnSocketConnection);
            }
            catch (Exception ex)
            {
                Log.Error(ex, "Exception while starting websocket server with url={0} and supportDualStack={1}", url, supportDualStack);
                try
                {
                    server.Dispose();
                }
                catch
                {
                    // skip
                }
                return null;
            }
            return server;
        }

        private void OnSocketConnection(IWebSocketConnection websocket)
        {
            Log.Debug("Handling websocket connection {0}: path={1}", websocket.ConnectionInfo.Id, websocket.ConnectionInfo.Path);
            var urlPath = websocket.ConnectionInfo.Path.TrimEnd('/');
            if (string.IsNullOrEmpty(urlPath))
            {
                var connection = new WebSocketServerTransmissionConnection(websocket);
                TaskRunner.RunInBackground(AcceptWebSocketConnectionAsync, connection).IgnoreAwait(Log);
            }
            else
            {
                var connectedCompletion = new Promise();
                void OnOpened() => connectedCompletion.TryComplete();
                void OnClosed() => connectedCompletion.TryFail(new Exception("Websocket unexpectedly closed"));
                void OnError(Exception ex) => connectedCompletion.TryFail(new Exception("Websocket exception occurred", ex));
                websocket.OnOpen = OnOpened;
                websocket.OnClose = OnClosed;
                websocket.OnError = OnError;
                TaskRunner.RunInBackground(async () =>
                {
                    try
                    {
                        await connectedCompletion.Task;
                    }
                    finally
                    {
                        // ReSharper disable DelegateSubtraction
                        websocket.OnOpen -= OnOpened;
                        websocket.OnClose -= OnClosed;
                        websocket.OnError -= OnError;
                        // ReSharper restore DelegateSubtraction
                    }
                    await ReadFileAsync(websocket, urlPath);
                }).IgnoreAwait(Log);
            }
        }

        private async Task ReadFileAsync(IWebSocketConnection webSocket, string urlPath)
        {
            try
            {
                if (_options.StaticFileMappings.TryGetValue(urlPath, out var physicalPath) && File.Exists(physicalPath))
                {
                    using (var stream = File.Open(physicalPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                    using (var streamReader = new StreamReader(stream))
                    {
                        await webSocket.Send(await streamReader.ReadToEndAsync()).ConfigureAwait(false);
                    }
                }
                else
                {
                    webSocket.Close();
                }
            }
            catch (Exception ex)
            {
                Log.Warn(ex, "Exception while serving static file via websocket");
                webSocket.Close();
            }
        }

        private async Task AcceptWebSocketConnectionAsync(object arg)
        {
            var connection = (WebSocketServerTransmissionConnection) arg;
            try
            {                
                connection.Start();
                using (CancellationToken.Register(connection.Stop))
                {
                    await _buffer.Out.WriteAsync(connection, CancellationToken).ConfigureAwait(false);
                    Log.Debug("Websocket connection {0} accepted", connection.Id);
                    await connection.Completion.ConfigureAwait(false);
                    Log.Debug("Websocket connection {0} completed", connection.Id);
                }
            }
            catch (Exception ex)
            {                
                Log.Warn(ex, "Websocket connection {0} completed with exception", connection.Id);
                connection.Stop();
            }
        }        
    }
}
