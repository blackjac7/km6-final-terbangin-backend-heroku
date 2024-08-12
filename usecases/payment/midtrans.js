const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { getUserById } = require("../../repositories/user/index");
const { getPaymentById } = require("../../repositories/payment/index");
const {
    getBookingsByPaymentId,
    getBookingByUserIdAndPaymentId,
} = require("../../repositories/booking/index");
const { createNotification } = require("../../repositories/notification/index");
const HttpError = require("../../utils/HttpError");
const { PaymentStatus, Midtrans } = require("../../utils/constants");
const { updatePaymentById } = require("../../repositories/payment/index");
const {
    getHelperBookingByBookingId,
} = require("../../repositories/helperBooking");
const { decrementFlightCapacity } = require("../../repositories/flight");
const { updateSeat } = require("../../repositories/seat");

/**
 * - nge-return object dengan key token dan redirect_url
 * - token bisa dipake untuk nge-display snap payment secara embedded (untuk web)
 * - redirect_url dipake untuk ngarahin ke suatu page snap payment (untuk android)
 */
exports.generateMidtransTransaction = async (payment) => {
    const belongingUser = await getUserById(payment.userId);
    const payload = {
        transaction_details: {
            order_id: payment.id,
            gross_amount: payment.totalPrice,
        },
        credit_card: {
            secure: true,
        },
        customer_details: {
            first_name: belongingUser.fullName,
            email: belongingUser.email,
            phone: belongingUser.phoneNumber,
        },
        item_details: [
            {
                id: payment.id,
                price: payment.totalPrice,
                quantity: 1,
                name: "Flight Ticket",
            },
        ],
    };
    // encode server key with base-64
    const authString = btoa(`${Midtrans.SERVER_KEY}:`);

    try {
        const response = await axios.post(
            Midtrans.TRANSACTION_SANDBOX_API,
            JSON.stringify(payload),
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Basic ${authString}`,
                },
            }
        );
        return response.data;
    } catch (e) {
        if (e.response) {
            // Server response status code that falls out of the range of 2xx
            console.error("Error response data:", e.response.data);
            console.error("Error response status:", e.response.status);
            console.error("Error response headers:", e.response.headers);
            throw new HttpError({
                statusCode: e.response.status,
                message: e.response.data.message || e.message,
            });
        } else if (e.request) {
            // No response was received from server
            console.error("Error request:", e.request);
            throw new HttpError({
                statusCode: 500,
                message: "No response received from Midtrans",
            });
        } else {
            // Something else happened while setting up the request
            console.error("Error message:", e.message);
            throw new HttpError({
                statusCode: 500,
                message: e.message,
            });
        }
    }
};

exports.getPaymentStatusFromTransactionStatus = (transactionStatus) => {
    switch (transactionStatus) {
        case "pending":
            return PaymentStatus.UNPAID;
        case "success":
            return PaymentStatus.ISSUED;
        case "settlement":
            return PaymentStatus.ISSUED;
        default:
            return PaymentStatus.CANCELLED;
    }
};

// method yg dijalanin sama midtrans setelah pembayaran
exports.handleMidtransNotification = async (notification, req) => {
    const orderId = notification.order_id; // sama aja kayak payment ID
    const transactionStatus = notification.transaction_status;
    const fraudStatus = notification.fraud_status;

    console.log(
        `Transaction notification received. Order ID: ${orderId}. Transaction status: ${transactionStatus}. Fraud status: ${fraudStatus}`
    );

    if (transactionStatus === "capture") {
        if (fraudStatus === "accept") {
            // TODO set transaction status on your database to 'success'
            // and response with 200 OK
            const transaction = await getPaymentById(orderId);

            if (transaction.status !== PaymentStatus.ISSUED) {
                const bookingId = await this.createNotificationByPaymentStatus(
                    orderId,
                    transaction.userId,
                    PaymentStatus.ISSUED
                );

                const helperBooking = await getHelperBookingByBookingId(
                    bookingId
                );

                let returnhelperbooking = [];
                let seatclassreturn = "";
                let onewayhelperbooking = [];
                let seatclassoneway = "";
                let flihgtonewayId = "";
                for (const booking of helperBooking) {
                    if (
                        booking?.Seat?.Flight?.id ===
                        booking?.Booking?.roundtripFlightId
                    ) {
                        returnhelperbooking.push(booking);
                        seatclassreturn = booking?.Seat?.airlineClass;
                    } else {
                        onewayhelperbooking.push(booking);
                        seatclassoneway = booking?.Seat?.airlineClass;
                        flihgtonewayId = booking?.Seat?.Flight?.id;
                    }
                }

                if (helperBooking && helperBooking.length > 0) {
                    if (helperBooking[0]?.Booking?.status === "Return") {
                        // mengurangi capacity penerbangan pulang
                        await decrementFlightCapacity(
                            seatclassreturn,
                            returnhelperbooking.length,
                            helperBooking[0]?.Booking?.roundtripFlightId
                        );
                        // mengurangi capacity penerbangan pergi
                        await decrementFlightCapacity(
                            seatclassoneway,
                            onewayhelperbooking.length,
                            flihgtonewayId
                        );
                    } else {
                        await decrementFlightCapacity(
                            seatclassoneway,
                            onewayhelperbooking.length,
                            flihgtonewayId
                        );
                    }

                    for (const booking of helperBooking) {
                        await updateSeat(booking.seatId, {
                            isAvailable: false,
                        });
                    }
                    req.io.emit("paymentSuccess", {
                        message: `Pembayaran berhasil dibayar sebesar`,
                        highlight: `Rp ${helperBooking[0].Booking.Payment.totalPrice}`,
                        userId: transaction.userId,
                    });

                    req.io.emit("seatsUpdate", {
                        message: "Seats Update",
                        flightId: helperBooking[0].Seat.flightId,
                        airlineClass: helperBooking[0].Seat.airlineClass,
                    });

                    req.io.emit("paymentUpdate", {
                        message: "Payment Update",
                    });
                }

                return updatePaymentById(orderId, {
                    status: PaymentStatus.ISSUED,
                });
            }
        }
    } else if (transactionStatus === "settlement") {
        // TODO set transaction status on your database to 'success'
        // and response with 200 OK
        const transaction = await getPaymentById(orderId);

        if (transaction.status !== PaymentStatus.ISSUED) {
            const bookingId = await this.createNotificationByPaymentStatus(
                orderId,
                transaction.userId,
                PaymentStatus.ISSUED
            );

            const helperBooking = await getHelperBookingByBookingId(bookingId);
            let returnhelperbooking = [];
            let seatclassreturn = "";
            let onewayhelperbooking = [];
            let seatclassoneway = "";
            let flihgtonewayId = "";
            for (const booking of helperBooking) {
                if (
                    booking?.Seat?.Flight?.id ===
                    booking?.Booking?.roundtripFlightId
                ) {
                    returnhelperbooking.push(booking);
                    seatclassreturn = booking?.Seat?.airlineClass;
                } else {
                    onewayhelperbooking.push(booking);
                    seatclassoneway = booking?.Seat?.airlineClass;
                    flihgtonewayId = booking?.Seat?.Flight?.id;
                }
            }

            if (helperBooking && helperBooking.length > 0) {
                if (helperBooking[0]?.Booking?.status === "Return") {
                    // mengurangi capacity penerbangan pulang
                    await decrementFlightCapacity(
                        seatclassreturn,
                        returnhelperbooking.length,
                        helperBooking[0]?.Booking?.roundtripFlightId
                    );
                    // mengurangi capacity penerbangan pergi
                    await decrementFlightCapacity(
                        seatclassoneway,
                        onewayhelperbooking.length,
                        flihgtonewayId
                    );
                } else {
                    await decrementFlightCapacity(
                        seatclassoneway,
                        onewayhelperbooking.length,
                        flihgtonewayId
                    );
                }

                for (const booking of helperBooking) {
                    await updateSeat(booking.seatId, {
                        isAvailable: false,
                    });
                }
                req.io.emit("paymentSuccess", {
                    message: `Pembayaran berhasil dibayar sebesar`,
                    highlight: `Rp ${helperBooking[0].Booking.Payment.totalPrice}`,
                    userId: transaction.userId,
                });

                req.io.emit("seatsUpdate", {
                    message: "Seats Update",
                    flightId: helperBooking[0].Seat.flightId,
                    airlineClass: helperBooking[0].Seat.airlineClass,
                });

                req.io.emit("paymentUpdate", {
                    message: "Payment Update",
                });
            }

            return updatePaymentById(orderId, {
                status: PaymentStatus.ISSUED,
            });
        }
    } else if (
        transactionStatus === "cancel" ||
        transactionStatus === "deny" ||
        transactionStatus === "expire" ||
        transactionStatus === "failure" ||
        transactionStatus === "void"
    ) {
        // TODO set transaction status on your database to 'failure'
        // and response with 200 OK
        const transaction = await getPaymentById(orderId);

        if (transaction.status !== PaymentStatus.CANCELLED) {
            const bookingId = await this.createNotificationByPaymentStatus(
                orderId,
                transaction.userId,
                PaymentStatus.CANCELLED
            );

            const helperBooking = await getHelperBookingByBookingId(bookingId);

            if (helperBooking && helperBooking.length > 0) {
                for (const booking of helperBooking) {
                    await updateSeat(booking.seatId, {
                        isAvailable: true,
                    });
                }

                req.io.emit("seatsUpdate", {
                    message: "Seats Update",
                    flightId: helperBooking[0].Seat.flightId,
                    airlineClass: helperBooking[0].Seat.airlineClass,
                });

                req.io.emit("paymentFailed", {
                    message: `Pembayaran anda telah expired`,
                    highlight: `Order ID ${orderId}`,
                    userId: transaction.userId,
                });

                req.io.emit("paymentUpdate", {
                    message: "Payment Update",
                });
            }

            return updatePaymentById(orderId, {
                status: PaymentStatus.CANCELLED,
            });
        }
    } else if (transactionStatus === "pending") {
        // TODO set transaction status on your database to 'pending' / waiting payment
        // and response with 200 OK
        const transaction = await getPaymentById(orderId);

        if (transaction.status === PaymentStatus.UNPAID) {
            const bookingId = await this.createNotificationByPaymentStatus(
                orderId,
                transaction.userId,
                PaymentStatus.UNPAID
            );

            const helperBooking = await getHelperBookingByBookingId(bookingId);

            if (helperBooking && helperBooking.length > 0) {
                for (const booking of helperBooking) {
                    await updateSeat(booking.seatId, {
                        isAvailable: false,
                    });
                }

                req.io.emit("seatsUpdate", {
                    message: "Seats Update",
                    flightId: helperBooking[0].Seat.flightId,
                    airlineClass: helperBooking[0].Seat.airlineClass,
                });

                req.io.emit("paymentUpdate", {
                    message: "Payment Update",
                });
            }

            return updatePaymentById(orderId, {
                status: PaymentStatus.UNPAID,
            });
        }
    } else {
        const transaction = await getPaymentById(orderId);

        if (transaction.status !== PaymentStatus.CANCELLED) {
            const bookingId = await this.createNotificationByPaymentStatus(
                orderId,
                transaction.userId,
                PaymentStatus.CANCELLED
            );

            const helperBooking = await getHelperBookingByBookingId(bookingId);

            if (helperBooking && helperBooking.length > 0) {
                for (const booking of helperBooking) {
                    await updateSeat(booking.seatId, {
                        isAvailable: true,
                    });
                }

                req.io.emit("seatsUpdate", {
                    message: "Seats Update",
                    flightId: helperBooking[0].Seat.flightId,
                    airlineClass: helperBooking[0].Seat.airlineClass,
                });

                req.io.emit("paymentFailed", {
                    message: `Pembayaran anda telah expired`,
                    highlight: `Order ID ${orderId}`,
                    userId: transaction.userId,
                });

                req.io.emit("paymentUpdate", {
                    message: "Payment Update",
                });
            }

            return updatePaymentById(orderId, {
                status: PaymentStatus.CANCELLED,
            });
        }
    }
    return null;
};

exports.createNotificationByPaymentStatus = async (
    orderId,
    userId,
    updatedStatus
) => {
    const relatedBookings = await getBookingByUserIdAndPaymentId(
        userId,
        orderId
    );
    let notifMessage;

    if (relatedBookings.length > 0) {
        const bookingId = relatedBookings[0].id;

        switch (updatedStatus) {
            case PaymentStatus.ISSUED:
                notifMessage = `Data payment anda dengan kode booking ${relatedBookings[0].bookingCode} telah ber-status ${updatedStatus}. Nikmati perjalanan anda!`;
                break;
            case PaymentStatus.UNPAID:
                notifMessage = `Data payment anda dengan kode booking ${relatedBookings[0].bookingCode} masih ber-status ${updatedStatus}. Segera selesaikan pembayaran anda!`;
                break;
            case PaymentStatus.CANCELLED:
                notifMessage = `Pembayaran anda dengan kode booking ${relatedBookings[0].bookingCode} ber-status ${updatedStatus}!`;
                break;
            default:
                notifMessage = `Pembayaran anda dengan kode booking ${relatedBookings[0].bookingCode} telah di ${updatedStatus}!`;
                break;
        }
        const notif = await createNotification({
            id: uuidv4(),
            userId,
            bookingId,
            title: "Payment",
            message: notifMessage,
            statusRead: false,
        });

        return notif.bookingId;
    }
};

const createPaymentInvoice = async (payment) => {
    const belongingUser = await getUserById(payment.userId);
    const belongingBookings = await getBookingsByPaymentId(payment.id);
    const currentDate = new Date();
    const payload = {
        order_id: payment.id,
        invoice_number: uuidv4(),
        due_date: currentDate.toISOString(),
        invoice_date: currentDate.toISOString(),
        customer_details: {
            id: belongingUser.id,
            name: belongingUser.fullName,
            email: belongingUser.email,
            phone: belongingUser.phoneNumber,
        },
        item_details: [
            {
                item_id: belongingBookings[0].id,
                price: payment.totalPrice,
                description: "some description",
                quantity: belongingBookings.length,
            },
        ],
        notes: "invoice pembelian tiket",
        payment_type: "payment_link",
    };
    // encode server key with base-64
    const authString = btoa(`${Midtrans.SERVER_KEY}:`);

    try {
        const response = await axios.post(
            Midtrans.INVOICE_SANDBOX_API,
            JSON.stringify(payload),
            {
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Basic ${authString}`,
                },
            }
        );
        const data = response.data;
        // TO DO: add data invoice ke DB
    } catch (e) {
        throw new HttpError({
            statusCode: e.httpStatusCode,
            message: e.message,
        });
    }
};
