# Web UI Libraries
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
import uuid
import jsonpatch
import json
def is_graph_message(text):
    import re
    # Remove markdown code block if present
    code_block = re.search(r"```(?:json)?\s*([\s\S]+?)\s*```", text)
    if code_block:
        text = code_block.group(1).strip()
    # Remove leading/trailing whitespace
    text = text.strip()
    try:
        obj = json.loads(text)
        return obj.get("type") in ["tableau", "plotly"], obj
    except Exception:
        return (False, None)
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from contextlib import asynccontextmanager

from pprint import pprint

# MCP libraries
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

# LangChain Libraries
from langchain_mcp_adapters.tools import load_mcp_tools
from langchain_openai import ChatOpenAI
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_anthropic import ChatAnthropic
from langgraph.prebuilt import create_react_agent
from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import InMemorySaver

# Set Local MCP Logging
from utilities.logging_config import setup_logging
logger = setup_logging("web_app.log")

# Load System Prompt and Message Formatter
from utilities.prompt import AGENT_SYSTEM_PROMPT
from utilities.chat import format_agent_response

# Load Environment and set MCP Filepath
import os
from dotenv import load_dotenv

load_dotenv()
mcp_location = os.environ['TABLEAU_MCP_FILEPATH']

# Import and Initialize Langfuse
from langfuse import Langfuse, get_client
from langfuse.langchain import CallbackHandler

# Initialize Langfuse client once with environment variables
Langfuse()

# Global variables for agent and session
agent = None
session_context = None

def generic_encoder(obj):
    """
    A generic JSON encoder for objects.
    
    Tries to convert an object to its dictionary representation.
    If that's not possible, it falls back to the object's string representation.
    """
    try:
        return vars(obj)
    except TypeError:
        return repr(obj)

# Global async context manager for MCP connection
@asynccontextmanager
async def lifespan(app: FastAPI):
    global agent
    logger.info("Starting up application...")
    
    try:
        server_params = StdioServerParameters(
            command="node",
            args=[mcp_location],
        )

        async with stdio_client(server_params) as (read, write):
            async with ClientSession(read, write) as client_session:
                await client_session.initialize()
                mcp_tools = await load_mcp_tools(client_session)
                
                match os.environ['MODEL_PROVIDER']:
                    case 'OpenAI':
                        llm = ChatOpenAI(model=os.environ["OPENAI_MODEL"], temperature=0)
                    case 'Google':
                        llm = ChatGoogleGenerativeAI(model=os.environ["GEMINI_MODEL"], temperature=0)
                    case 'Anthropic':
                        llm = ChatAnthropic(
                            model=os.environ["ANTHROPIC_MODEL"], 
                            temperature=0, 
                            max_tokens=4096,
                            timeout=None,
                            max_retries=3
                        )
                    case _:
                        raise RuntimeError("Could not initialise llm")

                checkpointer = InMemorySaver()
                agent = create_react_agent(model=llm, tools=mcp_tools, prompt=AGENT_SYSTEM_PROMPT, checkpointer=checkpointer)
                yield
        
    except Exception as e:
        logger.error(f"Failed to initialize agent: {e}")
        raise

# Create FastAPI app with lifespan
app = FastAPI(
    title="Tableau AI Chat", 
    description="Simple AI chat interface for Tableau data",
    lifespan=lifespan
)

# Serve static files (HTML, CSS, JS)
app.mount("/static", StaticFiles(directory="static"), name="static")

# Request/Response models
class ChatRequest(BaseModel):
    message: str

class ChatResponse(BaseModel):
    response: str

@app.get("/")
def home():
    """Serve the main HTML page"""
    return FileResponse('static/index.html')

@app.get("/index.html")
def static_index():
    return FileResponse('static/index.html')

@app.get("/v2")
def chat_v2():
    """Serve the V2 chat page"""
    return FileResponse('static/chat_v2.html')

@app.post("/chat")
async def chat(request: ChatRequest) -> ChatResponse:
    """Handle chat messages - this is where the AI magic happens"""
    global agent

    if agent is None:
        logger.error("Agent not initialized")
        raise HTTPException(status_code=500, detail="Agent not initialized. Please restart the server.")

    try:
        messages = [HumanMessage(content=request.message)]
        langfuse = get_client()
        langfuse_handler = CallbackHandler(update_trace=True)

        with langfuse.start_as_current_span(name="chat-request") as span:
            chat_session_id = str(uuid.uuid4())
            span.update_trace(
                session_id=chat_session_id,
                input={"message": request.message}
            )
            response_text = await format_agent_response(agent, messages, langfuse_handler)

        return ChatResponse(response=response_text)

    except Exception as e:
        logger.error(f"Error processing chat request: {str(e)}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Error processing request: {str(e)}")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    temp_logs = []
    await websocket.accept()
    
    if agent is None:
        await websocket.send_json({"type": "error", "data": "Agent not initialized."})
        await websocket.close()
        return

    langfuse = get_client()
    conversation_id = str(uuid.uuid4())
    langfuse_handler = CallbackHandler(update_trace=True)

    try:
        tool_calls_running = set()
        tool_calls_finished = set()
        tool_calls_error = set()
        active_stream_id = None  # Pour suivre le streaming actif
        streaming_content = []   # Pour accumuler le contenu du streaming

        async def handle_tool_call(tool_obj, parent_chunk=None):
            try:
                tool_call_id = str(tool_obj.get('id', ''))
                tool_name = str(tool_obj.get('name', ''))

                if not tool_call_id or not tool_call_id.startswith(('tool_', 'toolu_')):
                    if isinstance(parent_chunk, dict):
                        for tc in parent_chunk.get('tool_calls', []):
                            if tc.get('id', '').startswith(('tool_', 'toolu_')):
                                tool_call_id = tc['id']
                                tool_name = tc.get('name', tool_name)
                                break
                        if not tool_call_id and 'additional_kwargs' in parent_chunk:
                            for tc in parent_chunk['additional_kwargs'].get('tool_calls', []):
                                if tc.get('id', '').startswith(('tool_', 'toolu_')):
                                    tool_call_id = tc['id']
                                    tool_name = tc.get('name', tool_name)
                                    break

                if tool_call_id and tool_call_id.startswith(('tool_', 'toolu_')):
                    # Initier un nouveau tool call
                    if tool_call_id not in tool_calls_running and tool_call_id not in tool_calls_finished:
                        logger.info(f"Starting new tool call {tool_call_id} ({tool_name})")
                        await websocket.send_json({
                            "type": "tool_message",
                            "data": {
                                "tool_call_id": tool_call_id,
                                "name": tool_name,
                                "args": {}
                            },
                            "state": "running"
                        })
                        tool_calls_running.add(tool_call_id)

            except Exception as e:
                logger.error(f"Error in handle_tool_call: {str(e)}")
                raise

        while True:
            data = await websocket.receive_json()

            if data.get("type") == "resync":
                conversation_id = data.get("session_id")
                if conversation_id:
                    langfuse_handler = CallbackHandler(update_trace=True)
                    history = agent.get_state(config={"configurable": {"thread_id": conversation_id}})
                    if history:
                        messages = history.values['messages']
                        await websocket.send_json({"type": "history", "history": [msg.dict() for msg in messages]})
                continue

            run_state = {}
            with langfuse.start_as_current_span(name="process-message") as span:
                span.update_trace(
                    session_id=conversation_id,
                    input={"message": data["message"]}
                )

                config = {
                    "configurable": {"thread_id": conversation_id},
                    "callbacks": [langfuse_handler],
                }

                async for log_patch in agent.astream_log(
                    {"messages": [HumanMessage(content=data["message"])]},
                    config=config,
                ):
                    run_state = jsonpatch.apply_patch(run_state, log_patch.ops, in_place=False)
                    temp_logs.append(log_patch.ops)
                    logger.debug(f"Log patch: {log_patch.ops}")

                    for op in log_patch.ops:
                        if op['op'] == 'add':
                            path_parts = op['path'].split('/')
                            value = op['value']

                            # Gestion des messages AI normaux
                            if 'streamed_output_str' in op['path'] and len(path_parts) > 3 and path_parts[1] == 'logs':
                                chunk = op['value']
                                
                                # Si c'est un nouveau tool streaming
                                if isinstance(chunk, list) and len(chunk) > 0 and isinstance(chunk[0], dict):
                                    first_item = chunk[0]
                                    
                                    # Détecter le début d'un nouveau streaming
                                    if 'id' in first_item and str(first_item['id']).startswith(('tool_', 'toolu_')):
                                        active_stream_id = str(first_item['id'])
                                        tool_name = first_item.get('name', 'Unknown Tool')  # Extraire le nom de l'outil
                                        streaming_content = []
                                        logger.info(f"Started streaming for tool {active_stream_id} ({tool_name})")

                                        # Annoncer le début du streaming avec le nom de l'outil
                                        await websocket.send_json({
                                            "type": "tool_message",
                                            "data": {
                                                "tool_call_id": active_stream_id,
                                                "name": tool_name,
                                                "partial_json": ""
                                            },
                                            "state": "streaming"
                                        })
                                        continue
                                    
                                    # Si on est en streaming actif et qu'on a un partial_json
                                    if active_stream_id and 'partial_json' in first_item:
                                        partial_json = first_item['partial_json']
                                        streaming_content.append(partial_json)
                                        logger.debug(f"Added streaming content for {active_stream_id}: {partial_json}")
                                        
                                        # Envoyer le nouveau contenu au frontend
                                        await websocket.send_json({
                                            "type": "tool_message",
                                            "data": {
                                                "tool_call_id": active_stream_id,
                                                "partial_json": partial_json
                                            },
                                            "state": "streaming"
                                        })
                                        continue
                                
                                # Fin du streaming si on reçoit une chaîne vide
                                if active_stream_id and chunk == '':
                                    logger.info(f"Finished streaming for tool {active_stream_id}")
                                    active_stream_id = None
                                    streaming_content = []
                                    continue
                                
                                # Traiter les messages AI normaux si ce n'est pas du streaming
                                if not active_stream_id:
                                    text = ""
                                    if isinstance(chunk, list):
                                        text = "".join([str(item.get('text', '')) for item in chunk if isinstance(item, dict)])
                                    elif isinstance(chunk, dict) and 'text' in chunk:
                                        text = str(chunk['text'])
                                    elif isinstance(chunk, str):
                                        text = chunk
                                    
                                    if text.strip():
                                        is_graph, graph_obj = is_graph_message(text)
                                        if is_graph:
                                            await websocket.send_json({
                                                "type": "graph_message",
                                                "data": graph_obj,
                                                "state": "running"
                                            })
                                        else:
                                            await websocket.send_json({
                                                "type": "ai_message",
                                                "data": text,
                                                "state": "running"
                                            })

                            # Gestion des tools normaux (non-streaming)
                            if isinstance(value, list):
                                for item in value:
                                    if isinstance(item, dict):
                                        await handle_tool_call(item, parent_chunk=value if isinstance(value, dict) else op.get('parent_chunk'))
                            elif isinstance(value, dict):
                                await handle_tool_call(value, parent_chunk=value)

                            # Handle tool call results
                            if isinstance(value, dict):
                                if isinstance(value.get('messages'), list) and value['messages']:
                                    message = value['messages'][0]
                                    tool_id = str(getattr(message, 'tool_call_id', ''))
                                    
                                    if (tool_id.startswith(('tool_', 'toolu_')) and 
                                        tool_id not in tool_calls_finished and 
                                        tool_id not in tool_calls_error):
                                        
                                        tool_name = getattr(message, 'name', '')
                                        logger.info(f"Processing tool call result for {tool_id} ({tool_name})")
                                        
                                        if hasattr(message, 'error') and getattr(message, 'error', None):
                                            error_msg = str(getattr(message, 'error', 'Unknown error'))
                                            logger.error(f"Tool call {tool_id} failed: {error_msg}")
                                            await websocket.send_json({
                                                "type": "tool_message",
                                                "data": {
                                                    "tool_call_id": tool_id,
                                                    "name": tool_name,
                                                    "output": error_msg
                                                },
                                                "state": "error"
                                            })
                                            tool_calls_error.add(tool_id)
                                        else:
                                            tool_content = getattr(message, 'content', '').strip()
                                            if tool_content:
                                                logger.info(f"Tool call {tool_id} completed successfully")
                                                is_graph, graph_obj = is_graph_message(tool_content)
                                                if is_graph:
                                                    await websocket.send_json({
                                                        "type": "graph_message",
                                                        "data": graph_obj,
                                                        "tool_call_id": tool_id,
                                                        "name": tool_name,
                                                        "state": "finished"
                                                    })
                                                else:
                                                    await websocket.send_json({
                                                        "type": "tool_message",
                                                        "data": {
                                                            "tool_call_id": tool_id,
                                                            "name": tool_name,
                                                            "output": tool_content
                                                        },
                                                        "state": "finished"
                                                    })
                                                tool_calls_finished.add(tool_id)
                                        
                                        if tool_id in tool_calls_running:
                                            tool_calls_running.remove(tool_id)
                                            logger.debug(f"Removed {tool_id} from running state")
                                
                                elif 'error' in value:
                                    tool_call_id = str(value.get('id', ''))
                                    if (tool_call_id.startswith(('tool_', 'toolu_')) and 
                                        tool_call_id not in tool_calls_error):
                                        
                                        error_msg = str(value.get('error', 'Unknown error'))
                                        logger.error(f"Direct error for tool call {tool_call_id}: {error_msg}")
                                        await websocket.send_json({
                                            "type": "tool_message",
                                            "data": {
                                                "tool_call_id": tool_call_id,
                                                "name": value.get('name', ''),
                                                "output": error_msg
                                            },
                                            "state": "error"
                                        })
                                        tool_calls_error.add(tool_call_id)
                                        
                                        if tool_call_id in tool_calls_running:
                                            tool_calls_running.remove(tool_call_id)
                                            logger.debug(f"Removed {tool_call_id} from running state due to error")

            await websocket.send_json({"type": "ai_message", "data": "", "state": "finished"})
            
            with open("patch_logs.txt", "a") as file:
                file.write("\n" + str(temp_logs))

            with open("latest_run_state.json", "w") as file:
                file.write(json.dumps(run_state, indent=4, default=generic_encoder))

    except WebSocketDisconnect:
        logger.info(f"Client with conversation_id {conversation_id} disconnected")
    except Exception as e:
        logger.error(f"WebSocket Error (conversation_id: {conversation_id}): {e}", exc_info=True)
        await websocket.send_json({"type": "error", "data": str(e)})
    finally:
        logger.info(f"Closing connection for conversation_id {conversation_id}")
        if not websocket.client_state == "DISCONNECTED":
            await websocket.close()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("web_app:app", host="0.0.0.0", port=8000, reload=True)