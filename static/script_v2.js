// WebSocket chat functionality

let socket;
let aiMessageBuffer = "";
let currentToolStreaming = null; // Pour suivre le streaming en cours

function setupWebSocket() {
    socket = new WebSocket("ws://localhost:8000/ws");

    socket.onopen = function(event) {
        console.log("WebSocket connection established.");
    };

    socket.onmessage = function(event) {
        const message = JSON.parse(event.data);
        console.log(message);
        handleSocketMessage(message);
    };

    socket.onclose = function(event) {
        console.log("WebSocket connection closed.");
        showResyncButton();
    };

    socket.onerror = function(error) {
        console.error("WebSocket error:", error);
        addMessage('Sorry, there was a connection error.', 'bot');
        showResyncButton();
    };
}

function showResyncButton() {
    const btn = document.getElementById('sendBtn');
    btn.disabled = false;
    btn.textContent = 'Reconnect';
    btn.classList.add('resync');
    btn.onclick = resyncConnection;
}

function resyncConnection() {
    console.log("Attempting to resync...");
    if (socket) {
        socket.close();
    }
    setupWebSocket();
    const session_id = localStorage.getItem('session_id');
    if (session_id) {
        const payload = {
            type: 'resync',
            session_id: session_id
        };
        // Need to wait for the connection to be open
        socket.onopen = function(event) {
            console.log("WebSocket re-connection established.");
            socket.send(JSON.stringify(payload));
            setButtonState(true);
            document.getElementById('sendBtn').onclick = sendMessage;
            document.getElementById('sendBtn').classList.remove('resync');
        };
    }
}

function handleSocketMessage(message) {
    const { type, data, state, session_id, history, tool_call_id, name } = message;

    if (type === 'graph_message') {
        // Tableau graph
        if (data.type === 'tableau' && data.src) {
            const vizDiv = document.createElement('div');
            vizDiv.className = 'message graph';
            const vizId = `tableauViz_${Date.now()}`;
            vizDiv.innerHTML = `<tableau-viz id="${vizId}" src="${data.src}" device="phone" toolbar="bottom" hide-tabs></tableau-viz>`;
            document.getElementById('chatBox').appendChild(vizDiv);
        }
        // Plotly graph
        else if (data.type === 'plotly' && data.data && data.layout) {
            const plotId = `plotly_${Date.now()}`;
            const plotDiv = document.createElement('div');
            plotDiv.className = 'message graph';
            plotDiv.id = plotId;
            document.getElementById('chatBox').appendChild(plotDiv);
            // Plotly config fallback
            const config = data.config || {};
            Plotly.newPlot(plotId, data.data, data.layout, config);
        }
        scrollToBottom();
        return;
    }

    if (type === 'thread_id' || type === 'session_id') {
        localStorage.setItem('session_id', session_id);
        return;
    }

    if (type === 'history') {
        const chatBox = document.getElementById('chatBox');
        chatBox.innerHTML = ''; // Clear chat
        history.forEach(msg => {
            if (msg.role === 'user') {
                addMessage(msg.content, 'user');
            } else if (msg.role === 'assistant') {
                addMessage(marked.parse(msg.content), 'bot');
            }
        });
        return;
    }

    if (type === 'ai_message') {
        if (data) {
            aiMessageBuffer += data;
        }

        let messageDiv = document.getElementById('current_ai_message');
        if (!messageDiv) {
            messageDiv = document.createElement('div');
            messageDiv.id = 'current_ai_message';
            messageDiv.className = 'message bot';
            document.getElementById('chatBox').appendChild(messageDiv);
        }

        // Process buffer for message separation
        while (aiMessageBuffer.includes('\n\n')) {
            const parts = aiMessageBuffer.split('\n\n');
            const completeMessage = parts.shift();

            if (completeMessage) {
                // Try to parse as graph JSON
                let graphObj = null;
                try {
                    // Remove markdown code block if present
                    const codeBlock = completeMessage.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
                    let jsonText = codeBlock ? codeBlock[1].trim() : completeMessage.trim();
                    graphObj = JSON.parse(jsonText);
                } catch (e) {}
                if (graphObj && (graphObj.type === 'plotly' || graphObj.type === 'tableau')) {
                    // Render graph
                    if (graphObj.type === 'tableau' && graphObj.src) {
                        const vizDiv = document.createElement('div');
                        vizDiv.className = 'message graph';
                        const vizId = `tableauViz_${Date.now()}`;
                        vizDiv.innerHTML = `<tableau-viz id="${vizId}" src="${graphObj.src}" device="phone" toolbar="bottom" hide-tabs></tableau-viz>`;
                        document.getElementById('chatBox').appendChild(vizDiv);
                    } else if (graphObj.type === 'plotly' && graphObj.data && graphObj.layout) {
                        const plotId = `plotly_${Date.now()}`;
                        const plotDiv = document.createElement('div');
                        plotDiv.className = 'message graph';
                        plotDiv.id = plotId;
                        document.getElementById('chatBox').appendChild(plotDiv);
                        const config = graphObj.config || {};
                        Plotly.newPlot(plotId, graphObj.data, graphObj.layout, config);
                    }
                    scrollToBottom();
                    messageDiv.remove();
                } else {
                    messageDiv.innerHTML = marked.parse(completeMessage);
                }
            }
            messageDiv.id = '';

            messageDiv = document.createElement('div');
            messageDiv.id = 'current_ai_message';
            messageDiv.className = 'message bot';
            document.getElementById('chatBox').appendChild(messageDiv);

            aiMessageBuffer = parts.join('\n\n');
        }

        // Try to parse buffer as graph JSON
        let graphObj = null;
        try {
            const codeBlock = aiMessageBuffer.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
            let jsonText = codeBlock ? codeBlock[1].trim() : aiMessageBuffer.trim();
            graphObj = JSON.parse(jsonText);
        } catch (e) {}
        if (graphObj && (graphObj.type === 'plotly' || graphObj.type === 'tableau')) {
            if (graphObj.type === 'tableau' && graphObj.src) {
                const vizDiv = document.createElement('div');
                vizDiv.className = 'message graph';
                const vizId = `tableauViz_${Date.now()}`;
                vizDiv.innerHTML = `<tableau-viz id="${vizId}" src="${graphObj.src}" device="phone" toolbar="bottom" hide-tabs></tableau-viz>`;
                document.getElementById('chatBox').appendChild(vizDiv);
            } else if (graphObj.type === 'plotly' && graphObj.data && graphObj.layout) {
                const plotId = `plotly_${Date.now()}`;
                const plotDiv = document.createElement('div');
                plotDiv.className = 'message graph';
                plotDiv.id = plotId;
                document.getElementById('chatBox').appendChild(plotDiv);
                const config = graphObj.config || {};
                Plotly.newPlot(plotId, graphObj.data, graphObj.layout, config);
            }
            scrollToBottom();
            messageDiv.remove();
            aiMessageBuffer = "";
        } else {
            messageDiv.innerHTML = marked.parse(aiMessageBuffer);
        }

        if (state === 'running') {
            moveTypingIndicatorToBottom();
        }

        if (state === 'finished') {
            // Vérification du buffer pour un graph
            let graphObj = null;
            try {
                const codeBlock = aiMessageBuffer.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
                let jsonText = codeBlock ? codeBlock[1].trim() : aiMessageBuffer.trim();
                graphObj = JSON.parse(jsonText);
            } catch (e) {}
            if (graphObj && (graphObj.type === 'plotly' || graphObj.type === 'tableau')) {
                if (graphObj.type === 'tableau' && graphObj.src) {
                    const vizDiv = document.createElement('div');
                    vizDiv.className = 'message graph';
                    const vizId = `tableauViz_${Date.now()}`;
                    vizDiv.innerHTML = `<tableau-viz id="${vizId}" src="${graphObj.src}" device="phone" toolbar="bottom" hide-tabs></tableau-viz>`;
                    document.getElementById('chatBox').appendChild(vizDiv);
                } else if (graphObj.type === 'plotly' && graphObj.data && graphObj.layout) {
                    const plotId = `plotly_${Date.now()}`;
                    const plotDiv = document.createElement('div');
                    plotDiv.className = 'message graph';
                    plotDiv.id = plotId;
                    document.getElementById('chatBox').appendChild(plotDiv);
                    const config = graphObj.config || {};
                    Plotly.newPlot(plotId, graphObj.data, graphObj.layout, config);
                }
                scrollToBottom();
                if (messageDiv) messageDiv.remove();
                aiMessageBuffer = "";
            } else {
                if (messageDiv) {
                    if (!aiMessageBuffer && messageDiv.innerHTML === '') {
                        messageDiv.remove();
                    } else {
                        messageDiv.id = '';
                    }
                }
                aiMessageBuffer = "";
            }
            setButtonState(true);
        }
    } else if (type === 'tool_message') {
        // Arrêter la bulle de texte en cours
        let currentDiv = document.getElementById('current_ai_message');
        if (currentDiv) {
            currentDiv.id = '';
        }
        aiMessageBuffer = "";

        moveTypingIndicatorToBottom();

        // Chercher un div existant pour ce tool_call_id
        let toolDiv = document.querySelector(`.message.tool[data-tool-id="${data.tool_call_id}"]`);
        
        // Créer un nouveau div si nécessaire
        if (!toolDiv && (state === 'running' || state === 'streaming')) {
            toolDiv = document.createElement('div');
            toolDiv.className = 'message tool';
            toolDiv.setAttribute('data-tool-id', data.tool_call_id);
            document.getElementById('chatBox').appendChild(toolDiv);
        } else if (!toolDiv) {
            console.warn(`No tool div found for tool_call_id: ${data.tool_call_id} in state: ${state}`);
            return;
        }

        const icon = state === 'finished' ? '✓' : 
                    state === 'error' ? '✕' : 
                    '↻';
        const iconClass = state === 'finished' ? 'success' : 
                         state === 'error' ? 'error' : 
                         'pending';
        const toolName = data.name ? `Tableau : ${data.name}` : 'Unknown Tool';

        // Gestion du streaming
        if (state === 'streaming') {
            currentToolStreaming = data.tool_call_id;
            let requestField = toolDiv.querySelector('.tool-request');
            
            if (!requestField) {
                const header = document.createElement('div');
                header.className = 'tool-header';
                header.style.cursor = 'pointer';
                header.innerHTML = `
                    <div class="tool-icon ${iconClass}">${icon}</div>
                    <div>[Tool call] ${toolName}</div>
                `;
                
                const content = document.createElement('div');
                content.className = 'tool-content';
                content.innerHTML = '<strong>Request:</strong>';
                
                requestField = document.createElement('pre');
                requestField.className = 'tool-request';
                content.appendChild(requestField);
                
                toolDiv.appendChild(header);
                toolDiv.appendChild(content);
                
                // Update the header text with the tool name if available
                if (toolName !== 'Unknown Tool') {
                    header.querySelector('div:last-child').textContent = `[Tool call] ${toolName}`;
                }
                
                // Add click handler
                header.onclick = function(e) {
                    toolDiv.classList.toggle('expanded');
                    e.stopPropagation();
                };
            }
            
            // Ajouter le nouveau morceau JSON et formatter
            if (data.partial_json) {
                let currentContent = requestField.textContent || '';
                currentContent += data.partial_json;
                
                // Essayer de formatter le JSON
                try {
                    const parsed = JSON.parse(currentContent);
                    requestField.textContent = JSON.stringify(parsed, null, 2);
                } catch (e) {
                    // Si le JSON n'est pas encore complet, garder le texte brut
                    requestField.textContent = currentContent;
                }
            }
            
            // Syntax highlighting
            requestField.className = 'tool-request language-json';
            Prism.highlightElement(requestField);
            return;
        }

        // Construction du contenu normal pour les autres états
        let content = `
            <div class="tool-header" style="cursor:pointer;">
                <div class="tool-icon ${iconClass}">${icon}</div>
                <div>[Tool call] ${toolName}</div>
            </div>
            <div class="tool-content">
                <strong>Request:</strong>
                <pre><code class="language-json">${escapeHtml(JSON.stringify(data.args || {}, null, 2))}</code></pre>`;

        if (state === 'finished' || state === 'error') {
            // Garder le contenu streamé si c'était en cours de streaming
            if (data.tool_call_id === currentToolStreaming) {
                const streamedContent = toolDiv.querySelector('.tool-request')?.textContent || '';
                
                // Mettre à jour l'icône et la classe
                const header = toolDiv.querySelector('.tool-header');
                if (header) {
                    header.querySelector('.tool-icon').textContent = icon;
                    header.querySelector('.tool-icon').className = `tool-icon ${iconClass}`;
                }

                // Formatter le contenu streamé ou mettre {} si vide
                const streamedRequest = toolDiv.querySelector('.tool-request');
                if (streamedRequest) {
                    try {
                        const content = streamedRequest.textContent.trim() || '{}';
                        const parsed = JSON.parse(content);
                        streamedRequest.textContent = JSON.stringify(parsed, null, 2);
                        Prism.highlightElement(streamedRequest);
                    } catch (e) {
                        console.warn('Could not parse final request JSON:', e);
                    }
                }

                // Ajouter la section output tout en préservant le contenu streamé
                const toolContent = toolDiv.querySelector('.tool-content');
                if (toolContent) {
                    let outputStr = '';
                    try {
                        const output = data.hasOwnProperty('output') ? data.output : data;
                        if (typeof output === 'string') {
                            outputStr = escapeHtml(output);
                            try {
                                const parsed = JSON.parse(output);
                                outputStr = escapeHtml(JSON.stringify(parsed, null, 2));
                            } catch (e) {
                                outputStr = escapeHtml(output);
                            }
                        } else if (typeof output === 'object') {
                            outputStr = escapeHtml(JSON.stringify(output, null, 2));
                        }
                    } catch (e) {
                        outputStr = 'Error processing output';
                        console.error('Error processing tool output:', e);
                    }

                    const outputElement = document.createElement('div');
                    outputElement.innerHTML = `
                        <strong>${state === 'finished' ? 'Output' : 'Error'}:</strong>
                        <pre><code class="language-json">${outputStr || 'No output'}</code></pre>
                    `;
                    toolContent.appendChild(outputElement);
                    Prism.highlightAllUnder(toolContent);
                }

                currentToolStreaming = null;
            } else {
                // Pour les tools non streamés, utiliser le comportement normal
                let outputStr = '';
                try {
                    const output = data.hasOwnProperty('output') ? data.output : data;
                    if (typeof output === 'string') {
                        outputStr = escapeHtml(output);
                        try {
                            const parsed = JSON.parse(output);
                            outputStr = escapeHtml(JSON.stringify(parsed, null, 2));
                        } catch (e) {
                            outputStr = escapeHtml(output);
                        }
                    } else if (typeof output === 'object') {
                        outputStr = escapeHtml(JSON.stringify(output, null, 2));
                    }
                } catch (e) {
                    outputStr = 'Error processing output';
                    console.error('Error processing tool output:', e);
                }
                
                content += `
                    <strong>${state === 'finished' ? 'Output' : 'Error'}:</strong>
                    <pre><code class="language-json">${outputStr || 'No output'}</code></pre>
                </div>`;

                toolDiv.innerHTML = content;

                const header = toolDiv.querySelector('.tool-header');
                if (header) {
                    header.onclick = function(e) {
                        toolDiv.classList.toggle('expanded');
                        e.stopPropagation();
                    };
                }
            }

            // Replier le message par défaut
            toolDiv.classList.remove('expanded');
            Prism.highlightAllUnder(toolDiv);
        } else {
            // Pour les états non terminaux (running)
            content += '</div>';
            if (!currentToolStreaming || data.tool_call_id !== currentToolStreaming) {
                toolDiv.innerHTML = content;

                const header = toolDiv.querySelector('.tool-header');
                if (header) {
                    header.onclick = function(e) {
                        toolDiv.classList.toggle('expanded');
                        e.stopPropagation();
                    };
                }

                toolDiv.classList.remove('expanded'); // Les messages sont repliés par défaut
                Prism.highlightAllUnder(toolDiv);
            }
        }
    }

    scrollToBottom();
}

function moveTypingIndicatorToBottom() {
    const typingDiv = document.getElementById('typing-indicator');
    if (typingDiv) {
        document.getElementById('chatBox').appendChild(typingDiv);
        scrollToBottom();
    }
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&#39;');
}

async function sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    
    if (!message) return;

    addMessage(message, 'user');
    input.value = '';
    
    setButtonState(false);

    if (!socket || socket.readyState !== WebSocket.OPEN) {
        addMessage("Not connected to the server.", "bot");
        showResyncButton();
        return;
    }

    const payload = {
        message: message,
        session_id: localStorage.getItem('session_id')
    };

    socket.send(JSON.stringify(payload));
}

function addMessage(text, type) {
    const chatBox = document.getElementById('chatBox');
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${type}`;
    messageDiv.innerHTML = text.replace(/\n/g, '<br>');
    chatBox.appendChild(messageDiv);
    scrollToBottom();
}

function setButtonState(enabled) {
    const btn = document.getElementById('sendBtn');
    btn.disabled = !enabled;
    btn.textContent = enabled ? 'Send' : 'Thinking...';
    btn.classList.remove('resync');
    btn.onclick = sendMessage;

    if (!enabled) {
        showTypingIndicator();
    } else {
        hideTypingIndicator();
    }
}

function showTypingIndicator() {
    hideTypingIndicator();
    const chatBox = document.getElementById('chatBox');
    const typingDiv = document.createElement('div');
    typingDiv.id = 'typing-indicator';
    typingDiv.className = 'message typing';
    typingDiv.innerHTML = `
        <div class="typing-indicator" style="height:18px;">
            <div class="typing-dot" style="width:6px;height:6px;"></div>
            <div class="typing-dot" style="width:6px;height:6px;"></div>
            <div class="typing-dot" style="width:6px;height:6px;"></div>
        </div>
        <span style="font-size:12px;">AI is writing...</span>
    `;
    chatBox.appendChild(typingDiv);
    requestAnimationFrame(() => {
        chatBox.appendChild(typingDiv);
        scrollToBottom();
    });
}

function hideTypingIndicator() {
    const typingDiv = document.getElementById('typing-indicator');
    if (typingDiv) {
        typingDiv.remove();
    }
}

function scrollToBottom() {
    const chatBox = document.getElementById('chatBox');
    chatBox.scrollTop = chatBox.scrollHeight;
}

function handleEnter(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage();
    }
}

document.addEventListener('DOMContentLoaded', function() {
    document.getElementById('messageInput').focus();
    setupWebSocket();
});