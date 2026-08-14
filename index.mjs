import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { 
  DynamoDBDocumentClient, 
  PutCommand, 
  GetCommand, 
  UpdateCommand, 
  QueryCommand 
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";

const client = new DynamoDBClient({});
const docClient = DynamoDBDocumentClient.from(client);

const TABLE_NAME = "tbl-docfy-recetas-dev";

export const handler = async (event) => {
  console.log("EVENTO RECIBIDO:", JSON.stringify(event, null, 2));

  try {
    const httpMethod = event.httpMethod || event.requestContext?.http?.method;
    const pathParameters = event.pathParameters || {};
    
    // Normalizar headers a minúsculas para evitar problemas de mayúsculas/minúsculas
    const headers = event.headers || {};
    const normalizedHeaders = Object.keys(headers).reduce((acc, key) => {
      acc[key.toLowerCase()] = headers[key];
      return acc;
    }, {});

    const consultorio_id = normalizedHeaders['consultorio_id'];
    const usuario_id = normalizedHeaders['usuario_id'];

    // Validar headers obligatorios (excepto para GET ALL si decides no exigirlos, aunque aquí los pedimos)
    if (!consultorio_id) {
      return response(400, { error: "El header 'consultorio_id' es obligatorio." });
    }

    let body = {};
    if (event.body) {
      body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    }

    switch (httpMethod) {
      case "POST":
        return await crearReceta(body, consultorio_id, usuario_id);

      case "GET":
        if (pathParameters.receta_id) {
          return await obtenerRecetaPorId(pathParameters.receta_id, consultorio_id);
        } else {
          return await listarRecetasPorConsultorio(consultorio_id);
        }

      case "PUT":
        if (!pathParameters.receta_id) {
          return response(400, { error: "Se requiere el 'receta_id' en la ruta para actualizar." });
        }
        return await actualizarReceta(pathParameters.receta_id, body, consultorio_id);

      default:
        return response(405, { error: `Método ${httpMethod} no permitido.` });
    }

  } catch (error) {
    console.error("Error en la Lambda:", error);
    return response(500, { error: "Error interno del servidor.", detalle: error.message });
  }
};

// --- OPERACIONES ---

async function crearReceta(data, consultorio_id, usuario_id) {
  const receta_id = randomUUID();
  const createdAt = new Date().toISOString(); // Requerido: fecha de creación

  // Mapeo y validación de la lista de medicamentos
  const medicamentos = Array.isArray(data.medicamentos) ? data.medicamentos.map(med => ({
    nombre: med.nombre || "",
    dosis: med.dosis || "",
    dias: med.dias || 0 // Cantidad de días que debe tomarlo
  })) : [];

  const nuevaReceta = {
    receta_id,
    consultorio_id,
    usuario_id: usuario_id || "sistema",
    turno_id: data.turno_id || null,
    paciente_id: data.paciente_id || null,
    medicamentos, // Lista estructurada con nombre, dosis y días
    indicaciones: data.indicaciones || "",
    createdAt,
    fecha_actualizacion: createdAt
  };

  await docClient.send(new PutCommand({
    TableName: TABLE_NAME,
    Item: nuevaReceta
  }));

  return response(201, { mensaje: "Receta creada exitosamente", data: nuevaReceta });
}

async function obtenerRecetaPorId(receta_id, consultorio_id) {
  const result = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { receta_id }
  }));

  if (!result.Item) {
    return response(404, { error: "Receta no encontrada." });
  }

  // Validación opcional de seguridad por consultorio
  if (result.Item.consultorio_id !== consultorio_id) {
    return response(403, { error: "No tienes permisos para ver esta receta." });
  }

  return response(200, { data: result.Item });
}

async function listarRecetasPorConsultorio(consultorio_id) {
  // Usamos el GSI 'consultorio_id' para listar de forma eficiente
  const result = await docClient.send(new QueryCommand({
    TableName: TABLE_NAME,
    IndexName: "consultorio_id", // Asegúrate de que este sea el nombre exacto del GSI en Terraform
    KeyConditionExpression: "consultorio_id = :cid",
    ExpressionAttributeValues: {
      ":cid": consultorio_id
    }
  }));

  return response(200, { data: result.Items || [] });
}

async function actualizarReceta(receta_id, data, consultorio_id) {
  // Primero verificamos que exista y pertenezca al consultorio
  const existing = await docClient.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: { receta_id }
  }));

  if (!existing.Item) {
    return response(404, { error: "Receta no encontrada." });
  }

  if (existing.Item.consultorio_id !== consultorio_id) {
    return response(403, { error: "No tienes permisos para modificar esta receta." });
  }

  const fecha_actualizacion = new Date().toISOString();

  const result = await docClient.send(new UpdateCommand({
    TableName: TABLE_NAME,
    Key: { receta_id },
    UpdateExpression: "SET medicamentos = :m, indicaciones = :i, fecha_actualizacion = :f",
    ExpressionAttributeValues: {
      ":m": data.medicamentos || existing.Item.medicamentos,
      ":i": data.indicaciones !== undefined ? data.indicaciones : existing.Item.indicaciones,
      ":f": fecha_actualizacion
    },
    ReturnValues: "ALL_NEW"
  }));

  return response(200, { mensaje: "Receta actualizada exitosamente", data: result.Attributes });
}

// Helper para formatear la respuesta HTTP estandarizada para API Gateway
function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*"
    },
    body: JSON.stringify(body)
  };
}